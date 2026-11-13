import type { AccessScope } from "./identity";
import type { McpClientLike } from "./mcp-client";
import { getAiSettingsWithKey } from "../ai-settings";
import { runAuditedToolCall } from "../ai-audit";
import { agenticAnswerWithMeta } from "../llm-client";
import { randomUUID } from "node:crypto";
import { ASSISTANT_PROMPT_VERSION, branchLabel, buildAssistantSystemPrompt } from "../llm-prompt";
import { contentEnabled, withAnswerSpan, withToolSpan, hashUser, truncate } from "../telemetry";
import { recentTurns } from "./memory";
import { FRESH_DATA_NUDGE, needsFreshNumbers } from "./fresh-data";

/**
 * Does this tool result say "I failed"?
 *
 * MCP errors arrive as `{"error":{"code":…,"message":…}}` in a normal, successful
 * response — nothing about the reply is exceptional, so only the payload says so.
 */
export function looksLikeToolError(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed);
  } catch {
    return false;
  }
}

export type ConversationContext = {
  /** The branches this answer is scoped to; memory from another scope is skipped. */
  scopeKey?: string;
  userText: string;
  /** The LINE account asking — the memory is scoped to this, not to the account. */
  lineUserId: string;
  /** When the question arrived; the prompt says "today" from this. */
  now?: Date;
  /**
   * Explicit prior turns. The LINE bot reads its own memory; the backoffice
   * console passes its thread, so the same answer path serves both without the
   * console's conversation landing in the bot's memory.
   */
  messages?: { role: "user" | "assistant"; content: string }[];
  roleLabel: string;
  branchContext: string;
  scope: AccessScope;
  /**
   * The LINE-linked account behind the message. Null only when a caller cannot
   * name one; the audit row records null rather than inventing an actor.
   */
  actorUserId?: string | null;
  /** What this person asked the chat to remember, e.g. `สาขาประจำ: แม่โจ้ (b1)`. */
  remembered?: string | null;
};

export type ConversationDeps = {
  mcp: McpClientLike;
  fetchImpl?: typeof fetch;
};

function buildSystemPrompt(ctx: ConversationContext, ownerPrompt: string, toolNames: readonly string[]): string {
  // The wildcard scope means tenant-wide, so the human label wins; otherwise
  // prefer the caller's resolved branch name and fall back to the raw ids.
  const branches = ctx.scope.branchIds.includes("*")
    ? branchLabel(["*"])
    : ctx.branchContext || branchLabel(ctx.scope.branchIds);
  return buildAssistantSystemPrompt({
    ownerPrompt,
    roleLabel: ctx.roleLabel,
    branches,
    toolNames,
    canViewRevenue: ctx.scope.canViewRevenue,
    now: ctx.now ?? new Date(),
    remembered: ctx.remembered ?? null
  });
}

type ChatMessage = {
  role: string;
  content?: string | null;
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
};

type ToolResultItem = { type?: string; text?: string };

type McpCallResultLike = { content?: ToolResultItem[]; isError?: boolean };

function toolResultText(result: McpCallResultLike): string {
  if (Array.isArray(result.content)) {
    return result.content
      .map((item) => (item?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(result);
}

export type ConversationAnswer = {
  text: string;
  /** Model turns taken, and tool calls made inside them — recorded per turn. */
  steps: number;
  toolCalls: number;
  /** Which tools ran, in order. The console shows this; the chat log records it. */
  toolNames: string[];
  model: string;
  /** The server-rules version that shaped the answer. */
  promptVersion: string;
  /** The span id shared with this answer's tool spans. */
  turnId: string;
  inputTokens: number;
  outputTokens: number;
  /** True when any tool answered with an error envelope (see memory.recentTurns). */
  toolError: boolean;
};

/**
 * What to tell the user when the answer could not be produced.
 *
 * The old single sentence ("เกิดข้อผิดพลาดในการประมวลผล") was true and useless: it
 * does not separate "the gateway is unreachable" — a deployment problem the owner
 * must see — from "this question broke the model", which is worth retrying. The AI
 * SDK throws `AI_APICallError` with a status for the first and `AI_RetryError` once
 * it has exhausted retries; both mean the same thing to the person holding the
 * phone, and something different to whoever fixes it.
 */
export function describeBotFailure(error: unknown): string {
  const name = typeof (error as { name?: unknown })?.name === "string" ? String((error as { name: string }).name) : "";
  const cause = (error as { cause?: unknown })?.cause;
  const status =
    (error as { statusCode?: unknown })?.statusCode ??
    (cause as { statusCode?: unknown })?.statusCode ??
    (error as { status?: unknown })?.status;
  const message = error instanceof Error ? error.message : String(error ?? "");

  const gatewayProblem =
    name.includes("APICallError") ||
    name.includes("RetryError") ||
    name.includes("NoOutputGenerated") ||
    (typeof status === "number" && status >= 500) ||
    /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|502|503|504/i.test(message);

  return gatewayProblem
    ? "ขออภัย ระบบผู้ช่วยเชื่อมต่อโมเดลไม่ได้ในขณะนี้ (เกตเวย์ไม่ตอบสนอง) กรุณาลองใหม่ภายหลัง หรือแจ้งผู้ดูแลระบบให้ตรวจสอบ"
    : "ขออภัย เกิดข้อผิดพลาดในการประมวลผล ลองถามใหม่อีกครั้ง";
}

export async function answerForMessage(
  ctx: ConversationContext,
  deps: ConversationDeps
): Promise<ConversationAnswer> {
  const turnId = randomUUID();
  // The span is opened before the work so a model that never returns still shows up in
  // the trace; the counts are filled in on the way out.
  return withAnswerSpan(
    {
      model: "pending",
      steps: 0,
      toolCalls: 0,
      promptVersion: ASSISTANT_PROMPT_VERSION,
      roleLabel: ctx.roleLabel,
      question: ctx.userText,
      turnId,
      sessionId: ctx.lineUserId ? hashUser(ctx.lineUserId) : undefined,
      finalize: (answer) => {
        const typed = answer as ConversationAnswer;
        // The model is only known once the answer arrives — `ctx.roleLabel` was a
        // placeholder so the span had something to open with.
        return {
          "llm.steps": typed.steps,
          "llm.tool_calls": typed.toolCalls,
          "gen_ai.request.model": typed.model,
          "gen_ai.usage.input_tokens": typed.inputTokens,
          "gen_ai.usage.output_tokens": typed.outputTokens,
          // The whole answer is already on the customer's phone and in chat_turn; it
          // leaves the machine only when the owner has said so out loud.
          ...(contentEnabled() ? { "langfuse.observation.output": truncate(typed.text) } : {})
        };
      }
    },
    () => answerOnce(ctx, deps, turnId)
  );
}

async function answerOnce(
  ctx: ConversationContext,
  deps: ConversationDeps,
  turnId: string
): Promise<ConversationAnswer> {
  // Tools that answered with an error, collected as they run: the turn is then marked
  // so the failed answer never becomes what the next question is told.
  const failedTools = new Set<string>();
  // The gateway config is now DB-driven (ai_settings) — the bot reads the
  // same baseURL/apiKey/model/prompt that the backoffice AI console manages.
  const settings = getAiSettingsWithKey();
  if (!settings.apiKey) {
    return {
      text: "ขออภัย ยังไม่ได้ตั้งค่า API key ของผู้ช่วย กรุณาให้ผู้ดูแลระบบตั้งค่าในหน้า AI Console",
      steps: 0,
      toolCalls: 0,
      toolNames: [],
      model: settings.model,
      promptVersion: ASSISTANT_PROMPT_VERSION,
      turnId,
      inputTokens: 0,
      outputTokens: 0,
      toolError: false
    };
  }

  // Narrowed once, outside the closure below: the guard above proves it is set, but a
  // closure does not inherit that narrowing.
  const apiKey = settings.apiKey;
  const tools = await deps.mcp.listTools(ctx.scope);
  // The last few turns, so a follow-up can refer to what came before. Read per
  // message, not cached: the container restarts on deploy and the conversation
  // must survive that.
  const history = ctx.messages ?? recentTurns(ctx.lineUserId, undefined, ctx.scopeKey ?? "all");
  // The SDK executes tool calls itself; each MCP tool becomes an SDK tool
  // whose execute routes back to the MCP data server.
  // The base URL belongs in the log next to the failure: "502" is a deployment
  // fact and the stack trace alone does not name the host that did not answer.
  const ask = (instructions: string) =>
    agenticAnswerWithMeta(settings.baseUrl, apiKey, settings.model, {
      instructions,
      input: ctx.userText,
      messages: history,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown> | undefined
      })),
      execute: async (name: string, args: Record<string, unknown>, meta: { toolCallId?: string } | undefined) => {
        const toolArgs = { ...args };
        delete toolArgs.accessScope;
        // Exactly one audit row per call, on success and on failure. The row
        // carries a digest of the arguments, never the arguments: they hold branch
        // ids and revenue scopes, and an audit table must not become a second copy
        // of the data it audits.
        return runAuditedToolCall({
          tool: name,
          toolCallId: meta?.toolCallId ?? null,
          actorUserId: ctx.actorUserId ?? null,
          model: settings.model,
          args: toolArgs,
          execute: async () =>
            // Its own span, so "89 seconds" can be attributed to one call instead of
            // being one number for four.
            withToolSpan(
              name,
              turnId,
              async () => {
                const text = toolResultText(await deps.mcp.callTool(name, toolArgs, ctx.scope));
                if (looksLikeToolError(text)) failedTools.add(name);
                return text;
              },
              { args: toolArgs }
            )
        });
      },
      temperature: settings.temperature,
      // Bounded by the owner's setting: 2 was a single tool round-trip, which cannot
      // answer "compare branch A with B". The loop is bounded so cost stays predictable.
      maxSteps: settings.maxSteps,
      fetchImpl: deps.fetchImpl
    }).catch((error: unknown) => {
      console.error("LLM call failed", { baseUrl: settings.baseUrl, model: settings.model, error });
      throw error;
    });

  const baseInstructions = buildSystemPrompt(ctx, settings.systemPrompt, tools.map((tool) => tool.name));
  let result = await ask(baseInstructions);

  // A question that asks for a measurement, answered without measuring anything, is
  // answered from the transcript: the previous card's numbers become today's. It reads
  // perfectly, which is why it needs a code check rather than a prompt rule — measured
  // in production as one step, zero tool calls, and figures 2.5 hours old.
  if (needsFreshNumbers(ctx.userText) && result.toolCalls === 0 && tools.length > 0) {
    result = await ask(`${baseInstructions}\n\n${FRESH_DATA_NUDGE}`);
  }

  return {
    text: result.text,
    steps: result.steps,
    toolCalls: result.toolCalls,
    toolNames: result.toolNames,
    model: settings.model,
    promptVersion: ASSISTANT_PROMPT_VERSION,
    turnId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    toolError: failedTools.size > 0
  };
}