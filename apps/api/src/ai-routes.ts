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
  updateAiSettings
} from "./ai-settings";
import { randomUUID } from "node:crypto";
import { plainChat } from "./llm-client";

type AppEnv = { Variables: { principal: Principal | null } };

const settingsSchema = z.object({
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional().nullable(),
  model: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  temperature: z.number().int().min(0).max(100).optional()
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

export function registerAiRoutes(app: Hono<AppEnv>) {
  // Owner-gated middleware for the whole /api/ai surface.
  app.use("/api/ai/*", async (c, next) => {
    const owner = requireOwner(c);
    if (!owner) {
      return c.json({ error: { code: "forbidden", message: "Owner role required" } }, 403);
    }
    await next();
  });

  app.get("/api/ai/settings", (c) => {
    return c.json({ settings: getAiSettings() });
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

  // Simple non-streaming chat through the configured gateway. Stores both
  // sides in chat_history (30-day retention). Tool calling is NOT wired here
  // yet — the playground is a plain chat completion; MCP tools remain the
  // analytical surface used by the LINE bot.
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
    addChatMessage({ threadId, userId: owner.user.id, role: "user", content: parsed.data.message, model: settings.model });

    try {
      const reply = await plainChat(
        settings.baseUrl,
        settings.apiKey,
        settings.model,
        settings.systemPrompt,
        parsed.data.message,
        { temperature: settings.temperature }
      );
      addChatMessage({
        threadId,
        userId: owner.user.id,
        role: "assistant",
        content: reply,
        model: settings.model
      });
      return c.json({ threadId, reply });
    } catch (err) {
      return c.json({ error: { code: "gateway_unreachable", message: String(err) } }, 502);
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

  // On-demand purge of messages older than the 30-day window.
  app.post("/api/ai/chat/purge", (c) => {
    const owner = requireOwner(c);
    if (!owner) return c.json({ error: { code: "forbidden", message: "Owner role required" } }, 403);
    const { purgeExpiredChatMessages } = require("./ai-settings");
    const deleted = purgeExpiredChatMessages();
    return c.json({ deleted });
  });
}