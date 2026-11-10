// AI console API routes (backoffice, owner-only). Sits under /api/ai.
// UI-facing: GET settings, PUT settings (upsert), GET models (from Bifrost /
// configured base_url, cached), POST chat (completion through the gateway),
// GET chat history (30-day retention). API keys never leave the server.

import { Hono } from "hono";
import { z } from "zod";
import type { Principal } from "./access-store";
import {
  addChatMessage,
  getAiSettings,
  getAiSettingsWithKey,
  listChatMessages,
  isOwner,
  purgeExpiredChatMessages,
  updateAiSettings
} from "./ai-settings";
import { purgeExpiredChatTurns } from "./bot/memory";
import { answerForMessage, describeBotFailure } from "./bot/conversation";
import type { McpClientLike } from "./bot/mcp-client";
import { randomUUID } from "node:crypto";
import { recordAiChat, resolveAuditActor } from "./ai-audit";
import { ASSISTANT_PROMPT_VERSION, branchLabel, buildServerRules, renderSystemPrompt } from "./llm-prompt";
import { roleLabel, scopeForPrincipal } from "./bot/identity";

type AppEnv = { Variables: { principal: Principal | null } };

const settingsSchema = z.object({
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional().nullable(),
  model: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  temperature: z.number().int().min(0).max(100).optional(),
  // Tool round-trips per answer. 1 cannot answer with a tool, 6 is a loop rather
  // than an answer, so the range is narrow on purpose.
  maxSteps: z.number().int().min(1).max(6).optional()
});

const chatSchema = z.object({
  threadId: z.string().optional(),
  message: z.string().min(1).max(8000)
});

function requireOwner(c: { get: (k: "principal") => Principal | null }): Principal | null {
  const principal = c.get("principal");
  if (!principal) return null;
  return isOwner(principal.grants) ? principal : null;
}

export type AiRouteDeps = {
  /** The same MCP client the bot uses; the console must not have its own path. */
  mcp: McpClientLike;
};

export function registerAiRoutes(app: Hono<AppEnv>, deps: AiRouteDeps) {
  const { mcp } = deps;
  // Owner-gated middleware for the whole /api/ai surface.
  app.use("/api/ai/*", async (c, next) => {
    const owner = requireOwner(c);
    if (!owner) {
      return c.json({ error: { code: "forbidden", message: "Owner role required" } }, 403);
    }
    await next();
  });

  // Settings plus the rules the server appends. The console used to show only the
  // owner's persona, so the card read "คุณคือผู้ช่วยข้อมูล…" and nothing else — the
  // page of rules that actually shapes every answer was invisible to the person
  // responsible for it.
  app.get("/api/ai/settings", async (c) => {
    const owner = requireOwner(c);
    if (!owner) return c.json({ error: { code: "forbidden", message: "Owner role required" } }, 403);
    const scope = scopeForPrincipal(owner);
    let toolNames: string[] = [];
    try {
      toolNames = (await mcp.listTools(scope)).map((tool) => tool.name);
    } catch {
      // An unreadable tool list must not break the settings page; the preview then
      // shows the rules without the tool names.
    }
    return c.json({
      settings: getAiSettings(),
      prompt: {
        version: ASSISTANT_PROMPT_VERSION,
        rules: buildServerRules({
          roleLabel: roleLabel(owner),
          branches: branchLabel(scope.branchIds),
          toolNames,
          canViewRevenue: scope.canViewRevenue
        }),
        toolNames
      }
    });
  });

  app.put("/api/ai/settings", async (c) => {
    const owner = requireOwner(c);
    if (!owner) return c.json({ error: { code: "forbidden", message: "Owner role required" } }, 403);
    const body = await c.req.json().catch(() => null);
    const parsed = settingsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "invalid_input", message: parsed.error.message } }, 400);
    }
    const updated = updateAiSettings(parsed.data, owner.user.id);
    return c.json({ settings: updated });
  });

  // Model discovery: proxy GET {baseUrl}/v1/models (OpenAI-compatible).
  // Cached via the client side; here we always fetch fresh on demand.
  app.get("/api/ai/models", async (c) => {
    const settings = getAiSettingsWithKey();
    if (!settings.apiKey) {
      return c.json({ models: [], error: "no_api_key" });
    }
    try {
      const res = await fetch(`${settings.baseUrl.replace(/\/$/, "")}/v1/models`, {
        headers: { Authorization: `Bearer ${settings.apiKey}` }
      });
      if (!res.ok) {
        return c.json({ models: [], error: `gateway_${res.status}` }, 502);
      }
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const models = (data.data ?? []).map((m) => m.id).sort();
      return c.json({ models, error: null });
    } catch (err) {
      return c.json({ models: [], error: `gateway_unreachable: ${String(err)}` }, 502);
    }
  });

  // FULL-SYSTEM chat: the same answer path the LINE bot runs.
  //
  // This used to be a plain completion with no tools, and it answered — in Arabic,
  // saying it had no access to the shop's data. That is worse than broken: it looks
  // like a working console and proves nothing about what a customer will receive.
  //
  // The console now goes through `answerForMessage`, which is what the bot calls:
  // server-derived scope, the same MCP tools, the same system rules (role, branches,
  // today's date, no invented numbers), the same agentic loop and the same audit
  // rows. The only difference is where the history comes from — the console's thread
  // instead of the bot's chat_turn memory.
  app.post("/api/ai/chat", async (c) => {
    const owner = requireOwner(c);
    if (!owner) return c.json({ error: { code: "forbidden", message: "Owner role required" } }, 403);

    const body = await c.req.json().catch(() => null);
    const parsed = chatSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { code: "invalid_input", message: parsed.error.message } }, 400);
    }

    const settings = getAiSettingsWithKey();
    if (!settings.apiKey) {
      return c.json({ error: { code: "no_api_key", message: "Configure an API key in AI settings first" } }, 400);
    }

    const threadId = parsed.data.threadId ?? randomUUID();
    // `chat_message.user_id` is NOT NULL *and* a foreign key into `user(id)`.
    // The development bypass principal is deliberately not a persisted user
    // (`index.test.ts` asserts that reading `/api/me` in bypass mode creates no
    // user row), so its conversation cannot be stored: the request is still
    // answered and still audited, and the history write is skipped. In
    // production this branch never runs — every principal is a real user.
    const actor = resolveAuditActor(owner.user.id);
    const history = actor.actorUnresolved
      ? []
      : listChatMessages(threadId, owner.user.id, 20)
          .filter((message) => message.role === "user" || message.role === "assistant")
          // `listChatMessages` returns newest first; a model needs the conversation
          // oldest first, or it reads the answer before the question.
          .reverse()
          .map((message) => ({
            role: message.role as "user" | "assistant",
            content: message.content
          }));

    if (!actor.actorUnresolved) {
      addChatMessage({ threadId, userId: owner.user.id, role: "user", content: parsed.data.message, model: settings.model });
    }

    const startedAt = Date.now();
    try {
      const scope = scopeForPrincipal(owner);
      const answer = await answerForMessage(
        {
          userText: parsed.data.message,
          // No LINE user here; the history is explicit, so this is only an identity
          // for logs — and it must not collide with a real LINE id.
          lineUserId: `console:${owner.user.id}`,
          roleLabel: roleLabel(owner),
          branchContext: branchLabel(scope.branchIds),
          scope,
          actorUserId: owner.user.id,
          now: new Date(),
          messages: history
        },
        { mcp }
      );

      if (!actor.actorUnresolved) {
        addChatMessage({
          threadId,
          userId: owner.user.id,
          role: "assistant",
          content: answer.text,
          model: answer.model
        });
      }
      recordAiChat({
        actorUserId: owner.user.id,
        model: answer.model,
        threadId,
        messageCount: 1,
        usedTools: answer.toolCalls > 0,
        outcome: "ok"
      });

      // The trace is the point of a test console: which model answered, how many
      // turns and tools it took, and how long it was silent.
      return c.json({
        threadId,
        reply: answer.text,
        trace: {
          model: answer.model,
          steps: answer.steps,
          toolCalls: answer.toolCalls,
          tools: answer.toolNames,
          latencyMs: Date.now() - startedAt,
          scope: { branches: branchLabel(scope.branchIds), canViewRevenue: scope.canViewRevenue },
          maxSteps: settings.maxSteps,
          promptVersion: answer.promptVersion
        }
      });
    } catch (err) {
      recordAiChat({
        actorUserId: owner.user.id,
        model: settings.model,
        threadId,
        messageCount: 1,
        usedTools: false,
        outcome: "error"
      });
      // The console is where someone is debugging, so the real reason goes back to
      // it: "gateway_unreachable" with no detail is what made the last outage take
      // an afternoon to identify.
      return c.json(
        {
          error: {
            code: "chat_failed",
            message: err instanceof Error ? err.message : String(err),
            hint: describeBotFailure(err)
          },
          threadId
        },
        502
      );
    }
  });

  // Chat history for a thread (30-day retention enforced by purge job).
  app.get("/api/ai/chat", (c) => {
    const owner = requireOwner(c);
    if (!owner) return c.json({ error: { code: "forbidden", message: "Owner role required" } }, 403);
    const threadId = c.req.query("threadId");
    if (!threadId) {
      return c.json({ error: { code: "invalid_input", message: "threadId query required" } }, 400);
    }
    const messages = listChatMessages(threadId, owner.user.id).map((m) => ({
      role: m.role,
      content: m.content,
      model: m.model,
      createdAt: m.createdAt.getTime()
    }));
    return c.json({ messages });
  });

  // On-demand purge of conversation content older than the 30-day window.
  // It clears chat_message and the LINE bot's chat_turn: audit_log rows are
  // append-only and survive, so "the conversation was deleted" and "nothing was
  // ever called" stay different facts.
  app.post("/api/ai/chat/purge", (c) => {
    const owner = requireOwner(c);
    if (!owner) return c.json({ error: { code: "forbidden", message: "Owner role required" } }, 403);
    const deleted = purgeExpiredChatMessages();
    const deletedTurns = purgeExpiredChatTurns();
    return c.json({ deleted, deletedTurns });
  });
}