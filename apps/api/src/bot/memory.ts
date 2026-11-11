/**
 * The bot's memory: the last few turns of a LINE conversation.
 *
 * WHY THIS EXISTS. Every message used to reach the model as a standalone question,
 * so "แล้วเมื่อวานล่ะ" had nothing to refer to. A conversation is the difference
 * between a search box and an assistant, and the fix is small: store the turn, feed
 * the last few back as context.
 *
 * WHY A TABLE AND NOT A MAP. The container restarts on every deploy; an in-memory
 * history would silently reset mid-conversation and the bot would start answering
 * "which day do you mean?" — the failure would look like the model got worse.
 *
 * WHY EIGHT TURNS. Enough to resolve "last month", "that branch", "and yesterday";
 * short enough that a typical question stays well under a couple of thousand tokens.
 * Beyond that the cost per message climbs faster than the usefulness.
 *
 * WHY 30 DAYS. The same window as the playground's `chat_message`, purged by the
 * same job: long enough to answer a follow-up next week, short enough that this
 * does not quietly become a transcript of everything the shop ever asked.
 */

import { randomUUID } from "node:crypto";
import { asc, eq, lt } from "drizzle-orm";
import { db } from "../db";
import { chatTurn } from "../schema";

/** Turns fed back as context. A turn is one question and its answer. */
export const CHAT_MEMORY_TURNS = 8;

export const CHAT_TURN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ChatRole = "user" | "assistant";

export type ConversationTurn = { role: ChatRole; content: string };

export type AppendTurnInput = {
  lineUserId: string;
  userText: string;
  answerText: string;
  model?: string;
  steps?: number;
  toolCalls?: number;
  latencyMs?: number;
  /** Tokens for the whole answer, when the gateway reports them. */
  inputTokens?: number;
  outputTokens?: number;
  delivered?: "reply" | "push";
  at?: Date;
};

export function appendTurn(input: AppendTurnInput): void {
  db.insert(chatTurn)
    .values({
      id: randomUUID(),
      lineUserId: input.lineUserId,
      userText: input.userText,
      answerText: input.answerText,
      model: input.model ?? "",
      steps: input.steps ?? 0,
      toolCalls: input.toolCalls ?? 0,
      latencyMs: input.latencyMs ?? 0,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      delivered: input.delivered ?? "reply",
      createdAt: input.at ?? new Date()
    })
    .run();
}

/**
 * The last `limit` turns, oldest first — the order a chat model expects.
 *
 * Scoped by LINE user id, not by account: the memory belongs to the person typing,
 * and someone who holds grants on two branches still has one conversation.
 */
export function recentTurns(lineUserId: string, limit: number = CHAT_MEMORY_TURNS): ConversationTurn[] {
  if (limit <= 0) return [];
  const rows = db
    .select({ userText: chatTurn.userText, answerText: chatTurn.answerText })
    .from(chatTurn)
    .where(eq(chatTurn.lineUserId, lineUserId))
    .orderBy(chatTurn.createdAt)
    .all();

  // The tail of the conversation, kept in order: a plain `limit` on an ascending
  // query would return the FIRST turns, which is the opposite of memory.
  return rows
    .slice(Math.max(0, rows.length - limit))
    .flatMap((row) => [
      { role: "user" as const, content: row.userText },
      { role: "assistant" as const, content: row.answerText }
    ]);
}

/** Drop turns past the retention window. Returns how many rows went. */
export function purgeExpiredChatTurns(now: Date = new Date()): number {
  const cutoff = now.getTime() - CHAT_TURN_RETENTION_MS;
  const result = db.delete(chatTurn).where(lt(chatTurn.createdAt, new Date(cutoff))).run();
  return result.changes ?? 0;
}

/** How many turns one LINE user has stored — used by the admin view and tests. */
export function turnCount(lineUserId: string): number {
  return db.select().from(chatTurn).where(eq(chatTurn.lineUserId, lineUserId)).all().length;
}

/** Oldest first, for tests and for an operator looking at one conversation. */
export function allTurns(lineUserId: string) {
  return db
    .select()
    .from(chatTurn)
    .where(eq(chatTurn.lineUserId, lineUserId))
    .orderBy(asc(chatTurn.createdAt))
    .all();
}
