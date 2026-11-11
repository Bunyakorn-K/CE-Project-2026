/**
 * How much chat one person — and the shop as a whole — may have.
 *
 * WHY THIS EXISTS. Every answer is a paid model call, and the reply/push fallback
 * spends the same 300-message allowance the alerts live on. Before this, nothing
 * stopped one person from holding the bot in a loop all afternoon: the queue would
 * answer every message, one after another, at the model's price.
 *
 * WHY IT READS `chat_turn`. The table already records every answered message with
 * its timestamp and delivery kind, so the limit needs no counter that could drift
 * from reality — and it means "how many did we answer" and "how many may we answer"
 * are answered by the same rows.
 *
 * Days and hours are the shop's (Asia/Bangkok), not UTC: "you have used your day"
 * must mean the day the owner is living in.
 */

import { and, eq, gte } from "drizzle-orm";
import { db } from "../db";
import { chatTurn } from "../schema";
import { feedbackCounts } from "./feedback";

export const CHAT_HOURLY_LIMIT = 20;
export const CHAT_DAILY_LIMIT = 300;
const SHOP_TZ = "Asia/Bangkok";

/** `CHAT_ENABLED=false` turns the assistant off without a deploy. */
export function chatEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.CHAT_ENABLED ?? "true").trim().toLowerCase();
  return !(value === "false" || value === "0" || value === "off" || value === "no");
}

/** Midnight in the shop's timezone, as a UTC instant. */
export function shopDayStart(now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHOP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
  // Bangkok is UTC+7 with no daylight saving, so the offset is a constant.
  return new Date(`${parts}T00:00:00+07:00`);
}

export function hourStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - (now.getTime() % (60 * 60 * 1000)));
}

export type ChatLimitRefusal = {
  allowed: false;
  reason: "hourly" | "daily";
  message: string;
  retryAfterMinutes: number;
};

export type ChatLimitDecision = { allowed: true } | ChatLimitRefusal;

function countSince(where: ReturnType<typeof and>): number {
  const rows = db.select({ id: chatTurn.id }).from(chatTurn).where(where).all();
  return rows.length;
}

/**
 * The refusal message names the limit and when it lifts. A silent drop, or a
 * generic "try again", leaves the person tapping at a bot that stopped answering.
 */
export function evaluateChatLimit(input: {
  lineUserId: string;
  now?: Date;
  hourly?: number;
  daily?: number;
}): ChatLimitDecision {
  const now = input.now ?? new Date();
  const hourly = input.hourly ?? CHAT_HOURLY_LIMIT;
  const daily = input.daily ?? CHAT_DAILY_LIMIT;

  const dayStart = shopDayStart(now);
  const dailyUsed = countSince(gte(chatTurn.createdAt, dayStart));
  if (dailyUsed >= daily) {
    return {
      allowed: false,
      reason: "daily",
      message: `ระบบตอบคำถามครบโควตาของวันนี้แล้ว (${daily} ข้อความ) พรุ่งนี้ใช้งานได้ตามปกติ`,
      retryAfterMinutes: Math.max(1, Math.round((dayStart.getTime() + 86_400_000 - now.getTime()) / 60_000))
    };
  }

  const hourBegin = hourStart(now);
  const hourlyUsed = countSince(
    and(eq(chatTurn.lineUserId, input.lineUserId), gte(chatTurn.createdAt, hourBegin))
  );
  if (hourlyUsed >= hourly) {
    const resets = new Date(hourBegin.getTime() + 3_600_000);
    return {
      allowed: false,
      reason: "hourly",
      message: `คุณถามถี่เกินกำหนด (${hourly} ข้อความต่อชั่วโมง) กรุณาลองใหม่หลัง ${new Intl.DateTimeFormat("th-TH", {
        timeZone: SHOP_TZ,
        hour: "2-digit",
        minute: "2-digit"
      }).format(resets)}`,
      retryAfterMinutes: Math.max(1, Math.round((resets.getTime() - now.getTime()) / 60_000))
    };
  }

  return { allowed: true };
}

export type ChatStats = {
  day: string;
  turnsToday: number;
  repliesToday: number;
  pushesToday: number;
  /** Pushes this month — they spend the same allowance the alerts do. */
  pushesThisMonth: number;
  /** Thumbs from the people who were answered. */
  feedbackToday: { up: number; down: number };
  limits: { hourly: number; daily: number; enabled: boolean };
};

export function chatStats(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): ChatStats {
  const dayStart = shopDayStart(now);
  const monthStart = new Date(
    `${new Intl.DateTimeFormat("en-CA", { timeZone: SHOP_TZ, year: "numeric", month: "2-digit" }).format(now)}-01T00:00:00+07:00`
  );

  const today = db.select().from(chatTurn).where(gte(chatTurn.createdAt, dayStart)).all();
  const month = db.select().from(chatTurn).where(gte(chatTurn.createdAt, monthStart)).all();

  return {
    day: new Intl.DateTimeFormat("en-CA", { timeZone: SHOP_TZ }).format(now),
    turnsToday: today.length,
    repliesToday: today.filter((turn) => turn.delivered === "reply").length,
    pushesToday: today.filter((turn) => turn.delivered === "push").length,
    pushesThisMonth: month.filter((turn) => turn.delivered === "push").length,
    feedbackToday: feedbackCounts(dayStart),
    limits: { hourly: CHAT_HOURLY_LIMIT, daily: CHAT_DAILY_LIMIT, enabled: chatEnabled(env) }
  };
}
