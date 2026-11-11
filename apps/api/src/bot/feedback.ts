/**
 * The thumbs under an answer.
 *
 * One tap, no typing, no LINE message spent (a postback is not a message). It answers
 * the question no span can: was the answer right? A `down` beside a 6-second latency
 * says the problem is the data or the prompt, not the model.
 *
 * Keyed by turn, so a second tap changes nothing, and the row carries no text — the
 * transcript already has the words.
 */

import { randomUUID } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import { db } from "../db";
import { chatFeedback, chatTurn } from "../schema";

export type FeedbackRating = "up" | "down";
export type RecordResult = "recorded" | "duplicate" | "unknown-turn";

/**
 * Only the person who was answered may rate that answer: a turn id is not a secret,
 * and a postback payload is user-supplied.
 */
export function recordFeedback(input: { turnId: string; lineUserId: string; rating: FeedbackRating }): RecordResult {
  const turn = db.select().from(chatTurn).where(eq(chatTurn.id, input.turnId)).get();
  if (!turn || turn.lineUserId !== input.lineUserId) return "unknown-turn";

  const existing = db
    .select()
    .from(chatFeedback)
    .where(and(eq(chatFeedback.turnId, input.turnId), eq(chatFeedback.lineUserId, input.lineUserId)))
    .get();
  if (existing) {
    if (existing.rating === input.rating) return "duplicate";
    // A second, different tap is a correction: replace rather than accumulate.
    db.delete(chatFeedback).where(eq(chatFeedback.id, existing.id)).run();
  }

  db.insert(chatFeedback)
    .values({
      id: randomUUID(),
      turnId: input.turnId,
      lineUserId: input.lineUserId,
      rating: input.rating,
      createdAt: new Date()
    })
    .run();
  return "recorded";
}

export function feedbackCounts(since: Date): { up: number; down: number } {
  const rows = db.select().from(chatFeedback).where(gte(chatFeedback.createdAt, since)).all();
  return {
    up: rows.filter((row) => row.rating === "up").length,
    down: rows.filter((row) => row.rating === "down").length
  };
}

export function thanksText(rating: FeedbackRating): string {
  return rating === "up"
    ? "ขอบคุณครับ — ดีใจที่คำตอบมีประโยชน์"
    : "ขอบคุณที่บอกครับ ผมจะใช้ข้อมูลนี้ปรับการตอบ";
}

export const ALREADY_RATED = "ให้คะแนนคำตอบนี้ไว้แล้วครับ";
export const UNKNOWN_TURN = "ให้คะแนนคำตอบนี้ไม่ได้ (ไม่พบคำตอบ หรือไม่ใช่คำตอบของคุณ)";
