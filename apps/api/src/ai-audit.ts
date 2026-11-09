/**
 * Audit for the AI surface (R08 / F-07).
 *
 * WHY THIS EXISTS. The assistant and its six MCP tools run behind a bearer
 * token and a signed branch scope, but until this file there was no record of
 * what was called, by whom, with what. `audit_log` already held grants, alert
 * cooldowns and AI settings writes; the AI path simply never wrote to it. An
 * allow-listed surface with no audit trail answers "who could call this", never
 * "what was called".
 *
 * WHAT A ROW MAY NOT CONTAIN. Arguments are **digested**, not stored: a tool
 * call carries branch ids, date ranges and revenue scopes, and an audit table is
 * the wrong place to accumulate a second copy of them — the digest answers
 * "was this the same call as that one" without becoming a shadow copy of the
 * data. `argsKeys` keeps the shape (which arguments were used) because that is
 * the part a reviewer needs and the part that cannot leak a value.
 *
 * This tradeoff is deliberate and must not be "fixed" later by logging raw
 * arguments. If a future requirement needs the values, it needs its own store
 * with its own retention and its own access rule, not this table.
 *
 * NO ENVIRONMENT VALUE MAY APPEAR IN `detail`. Not a token, not a DSN, not a
 * model key. Nothing here reads `process.env`, and the error path records the
 * error's *name*, never its message, because a driver error message can quote a
 * connection string.
 */

import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { auditLog, user } from "./schema";

export type AiToolOutcome = "ok" | "error";

export type AiToolCallInput = {
  actorUserId: string | null;
  model: string;
  tool: string;
  toolCallId: string | null;
  args: Record<string, unknown>;
  outcome: AiToolOutcome;
  resultRows: number | null;
  durationMs: number;
  errorName?: string | null;
};

export type AiChatInput = {
  actorUserId: string | null;
  model: string;
  threadId: string;
  messageCount: number;
  usedTools: boolean;
  outcome: AiToolOutcome;
};

/** Recursively sort object keys so the digest is order-independent. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key]);
    return sorted;
  }
  return value === undefined ? null : value;
}

/**
 * SHA-256 over the canonicalised arguments.
 *
 * Canonicalised so `{a,b}` and `{b,a}` digest the same — otherwise the digest
 * would answer "were these serialised identically", which is not the question.
 */
export function argsDigest(args: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(args))).digest("hex");
}

/** The argument names only, sorted. Never a value. */
export function argsKeys(args: Record<string, unknown>): string[] {
  return Object.keys(args).sort();
}

/**
 * How many rows a tool answered with, when the answer says so.
 *
 * MCP tools here return the analytics envelope (`{data: [], meta: {}}`) as JSON
 * text. A non-JSON body, or one without `data`, reports `null` rather than 0 —
 * "we could not tell" is not "no rows".
 */
export function rowsInToolResult(text: string): number | null {
  try {
    const parsed = JSON.parse(text) as { data?: unknown };
    return Array.isArray(parsed.data) ? parsed.data.length : null;
  } catch {
    return null;
  }
}

/**
 * Make an actor id safe to store on a row whose column is a foreign key.
 *
 * `audit_log.actor_user_id` references `user(id)`, and the development bypass
 * principal (`development-owner`) is deliberately **not** a persisted user —
 * `index.test.ts` asserts that reading `/api/me` in bypass mode creates no user
 * row. A synthetic actor therefore cannot be stored verbatim: SQLite raises
 * `SQLITE_CONSTRAINT_FOREIGNKEY` and the whole request 500s (measured
 * 2026-11-09 on `PUT /api/ai/settings` in dev bypass).
 *
 * The invariant wins: the bypass stays in-memory, and the audit row says
 * `actorUserId: null` with `actorUnresolved: true`. A row that records "an
 * actor this table cannot name" is honest; dropping the row, or inventing a
 * user row so the write succeeds, is not.
 */
export function resolveAuditActor(actorUserId: string | null): {
  actorUserId: string | null;
  actorUnresolved: boolean;
} {
  if (!actorUserId) return { actorUserId: null, actorUnresolved: false };
  const row = db.select({ id: user.id }).from(user).where(eq(user.id, actorUserId)).get();
  if (row) return { actorUserId, actorUnresolved: false };
  return { actorUserId: null, actorUnresolved: true };
}

function writeRow(input: {
  actorUserId: string | null;
  action: string;
  target: string;
  detail: Record<string, unknown>;
}): string {
  const actor = resolveAuditActor(input.actorUserId);
  const id = randomUUID();
  db.insert(auditLog)
    .values({
      id,
      actorUserId: actor.actorUserId,
      action: input.action,
      target: input.target,
      detail: JSON.stringify(
        actor.actorUnresolved ? { ...input.detail, actorUnresolved: true } : input.detail
      ),
      createdAt: new Date()
    })
    .run();
  return id;
}

/** One row per tool call. `target` is the tool name. */
export function recordAiToolCall(input: AiToolCallInput): string {
  return writeRow({
    actorUserId: input.actorUserId,
    action: "ai.tool_call",
    target: input.tool,
    detail: {
      model: input.model,
      toolCallId: input.toolCallId,
      argsDigest: argsDigest(input.args),
      argsKeys: argsKeys(input.args),
      resultRows: input.resultRows,
      durationMs: input.durationMs,
      outcome: input.outcome,
      ...(input.errorName ? { errorName: input.errorName } : {})
    }
  });
}

/** One row per chat request, including whether the answer used a tool. */
export function recordAiChat(input: AiChatInput): string {
  return writeRow({
    actorUserId: input.actorUserId,
    action: "ai.chat",
    target: input.threadId,
    detail: {
      model: input.model,
      threadId: input.threadId,
      messageCount: input.messageCount,
      usedTools: input.usedTools,
      outcome: input.outcome
    }
  });
}

/**
 * Run one tool call and audit it exactly once, on both outcomes.
 *
 * The row is written in a `catch` as well as on success because "the tool threw"
 * is one of the things an audit is for. The error is re-thrown unchanged: an
 * audit that swallowed a failure would turn a broken tool into a silent one.
 */
export async function runAuditedToolCall(options: {
  tool: string;
  toolCallId: string | null;
  actorUserId: string | null;
  model: string;
  args: Record<string, unknown>;
  execute: () => Promise<string>;
}): Promise<string> {
  const startedAt = Date.now();
  try {
    const text = await options.execute();
    recordAiToolCall({
      actorUserId: options.actorUserId,
      model: options.model,
      tool: options.tool,
      toolCallId: options.toolCallId,
      args: options.args,
      outcome: "ok",
      resultRows: rowsInToolResult(text),
      durationMs: Date.now() - startedAt
    });
    return text;
  } catch (error) {
    recordAiToolCall({
      actorUserId: options.actorUserId,
      model: options.model,
      tool: options.tool,
      toolCallId: options.toolCallId,
      args: options.args,
      outcome: "error",
      resultRows: null,
      durationMs: Date.now() - startedAt,
      // The name only: a driver message can quote a DSN.
      errorName: error instanceof Error ? error.name : typeof error
    });
    throw error;
  }
}
