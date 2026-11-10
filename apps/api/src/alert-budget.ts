/**
 * The LINE message budget.
 *
 * WHY THIS EXISTS. A LINE Official Account on the free plan can push **300
 * messages a month**. An hourly alert on two gas channels is 1,440 — five times
 * the allowance — and every AI chat answer used to be a push as well, so the
 * quota would have been gone in the first week and the alerts would then have
 * failed silently at the API, which is the worst possible failure for a safety
 * notification.
 *
 * Two levers, in order of value:
 *
 *   1. Chat answers use the **reply** API (free, unlimited) whenever the reply
 *      token is still valid, and only fall back to push. That is in the bot, not
 *      here, and it is what makes the budget mostly about alerts.
 *   2. Alerts are counted against a monthly cap and re-notified on a floor
 *      (`ALERT_RENOTIFY_HOURS`, default 12) rather than every hour. When the cap
 *      is reached the sweep records `suppressed_budget` and an audit row — it
 *      does not pretend to have sent, and it does not go quiet without a trace.
 *
 * The month is counted in UTC. LINE's own billing month is not exposed to us, so
 * the cap is set below the real allowance (200 of 300) to absorb the difference
 * rather than to be exact about it.
 */

import { and, eq, gte } from "drizzle-orm";
import { db } from "./db";
import { alertNotification, chatTurn, digestSent } from "./schema";

export const DEFAULT_MONTHLY_BUDGET = 200;

export type BudgetState = {
  /** `YYYY-MM`, UTC. */
  month: string;
  used: number;
  cap: number;
  remaining: number;
  /** Which half of `used` is which — alerts and chat pushes share one allowance. */
  breakdown: { alerts: number; chat: number; digest: number };
};

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Messages already delivered this month.
 *
 * Counted from the notification table rather than a counter column: the rows are
 * the record of what LINE accepted, so the budget cannot drift from reality after
 * a crash, a redeploy or a manual send.
 */
export function monthlySentCount(now: Date): number {
  const rows = db
    .select({ id: alertNotification.id })
    .from(alertNotification)
    .where(and(eq(alertNotification.status, "sent"), gte(alertNotification.deliveredAt, monthStart(now))))
    .all();
  return rows.length;
}

/**
 * Chat answers that went out as pushes this month.
 *
 * They spend the same LINE allowance as the alerts: the reply path is free, but a
 * reply token that expires falls back to a push, and those messages come out of the
 * same 300. Counting them here is what keeps the alert cap honest — a busy month of
 * chat would otherwise leave the alerts to fail at the API with no warning.
 */
export function monthlyChatPushes(now: Date): number {
  const rows = db
    .select({ id: chatTurn.id })
    .from(chatTurn)
    .where(and(eq(chatTurn.delivered, "push"), gte(chatTurn.createdAt, monthStart(now))))
    .all();
  return rows.length;
}

/** Digest messages sent this month: one a day at most, but still out of the 300. */
export function monthlyDigestCount(now: Date): number {
  const rows = db
    .select({ id: digestSent.id })
    .from(digestSent)
    .where(and(eq(digestSent.status, "sent"), gte(digestSent.sentAt, monthStart(now))))
    .all();
  return rows.length;
}

export function budgetState(
  now: Date,
  cap: number = DEFAULT_MONTHLY_BUDGET,
  /** Injectable so a test can state its own chat usage instead of inheriting rows
   *  another test file wrote to the same table in parallel. */
  chatPushes: number = monthlyChatPushes(now),
  digestPushes: number = monthlyDigestCount(now)
): BudgetState {
  const alerts = monthlySentCount(now);
  const chat = chatPushes;
  const used = alerts + chat + digestPushes;
  return {
    month: monthKey(now),
    used,
    cap,
    remaining: Math.max(0, cap - used),
    /** Split out so the owner can see which half is growing. */
    breakdown: { alerts, chat, digest: digestPushes }
  };
}

/** The cap as configured, with a floor of 0 and a sane default. */
export function configuredBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALERT_MONTHLY_BUDGET;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MONTHLY_BUDGET;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MONTHLY_BUDGET;
  return Math.floor(parsed);
}

/**
 * How long before the same rule may notify again, in milliseconds.
 *
 * Twelve hours by default: two channels × two messages a day is 120 a month,
 * which fits the cap with room for a chat fallback. One hour — the old default —
 * is 1,440 and cannot fit any plan this deployment is on.
 */
export function configuredRenotifyMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALERT_RENOTIFY_HOURS;
  const hours = raw === undefined || raw.trim() === "" ? 12 : Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return 12 * 60 * 60 * 1000;
  return Math.round(hours * 60 * 60 * 1000);
}
