// Is a declining gas pressure still news?
//
// Measured on production 2026-11-13: 42 messages in five days across three channels,
// from a condition that had been true the whole time (`gas_run_a` 16, `gas_run_b` 22,
// `changeover_filter` 4). The 12-hour cooldown was working exactly as configured — one
// alert per channel per 12 h — so the repetition was the design, not a bug: a *state*
// was being announced instead of a *change*.
//
// This module answers one question per channel per sweep: has this episode changed
// enough to be worth another message? The comparison is against the last alert that was
// actually sent for that channel, whose own numbers are in `alert_notification.evidence`
// — so nothing new has to be stored, and an alert nobody received cannot become a
// baseline.
//
// Known limit, deliberately not solved here: a trend that recovers to steady and starts
// declining again inside the cadence is indistinguishable from a continuation, because no
// steady observation is stored. The cadence is what bounds it; separating the two cases
// would need episode state, which is a schema change and a different piece of work.

import { and, desc, eq } from "drizzle-orm";
import { db } from "./db";
import { alertNotification } from "./schema";

/** A decline is worth another message when its rate is this much steeper. */
export const RATE_WORSEN_FRACTION = 0.25;

/** …or when the pressure has fallen this much further since the last alert. */
export const DROP_WORSEN_PSI = 5;

/** What the last sent alert for one channel reported. */
export type GasEpisodePrevious = {
  edgeRatePsiPerHour: number;
  lastEdgePsi: number;
  /** When it was sent, in epoch milliseconds. */
  sentAt: number;
};

export type GasEpisodeDecision =
  | { notify: true; reason: "first_alert" | "rate_worsened" | "drop_worsened" | "reminder_due" }
  | { notify: false; reason: "unchanged_episode" };

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Decide whether to send another alert for one declining channel.
 *
 * Order: no usable previous → first alert; a materially steeper rate → escalate; a
 * materially lower pressure → escalate; the cadence has elapsed → remind; otherwise the
 * episode is unchanged and this sweep says nothing.
 *
 * Magnitudes, not signed values: the rates are negative (pressure falling), so "steeper"
 * means the absolute value grew. A zero previous rate has no percentage to grow from and
 * falls through to the pressure comparison.
 */
export function decideGasRenotify(input: {
  previous: GasEpisodePrevious | null;
  current: { edgeRatePsiPerHour: number; lastEdgePsi: number };
  now: number;
  renotifyMs: number;
}): GasEpisodeDecision {
  const { previous, current, now, renotifyMs } = input;

  // An older row's evidence may carry no numbers at all (the shape changed as the rule
  // was built), and a channel must not be silenced by a predecessor that cannot be read.
  if (!previous || !finite(previous.edgeRatePsiPerHour) || !finite(previous.lastEdgePsi) || !finite(previous.sentAt)) {
    return { notify: true, reason: "first_alert" };
  }

  if (finite(current.edgeRatePsiPerHour)) {
    const before = Math.abs(previous.edgeRatePsiPerHour);
    const after = Math.abs(current.edgeRatePsiPerHour);
    if (before > 0 && after >= before * (1 + RATE_WORSEN_FRACTION)) {
      return { notify: true, reason: "rate_worsened" };
    }
  }

  if (finite(current.lastEdgePsi) && previous.lastEdgePsi - current.lastEdgePsi >= DROP_WORSEN_PSI) {
    return { notify: true, reason: "drop_worsened" };
  }

  if (now - previous.sentAt >= renotifyMs) return { notify: true, reason: "reminder_due" };

  return { notify: false, reason: "unchanged_episode" };
}

/**
 * What the last alert for this channel actually reported.
 *
 * Read from `alert_notification` rather than kept in a new table: the evidence of the
 * alert that was sent is the baseline, and it cannot drift from what the recipient saw.
 * Only `sent` rows count — a failed attempt reached nobody, so it must not become the
 * reason the next one is suppressed.
 *
 * `null` when there is no such row, when its evidence carries no numbers (rows written
 * before the evidence had these fields), or when the JSON does not parse. Every one of
 * those means "treat this as a first alert", never "stay quiet".
 */
export function lastSentGasAlert(cooldownKey: string): GasEpisodePrevious | null {
  const row = db
    .select({ evidence: alertNotification.evidence, attemptedAt: alertNotification.attemptedAt })
    .from(alertNotification)
    .where(and(eq(alertNotification.cooldownKey, cooldownKey), eq(alertNotification.status, "sent")))
    .orderBy(desc(alertNotification.attemptedAt))
    .limit(1)
    .get();
  if (!row) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.evidence);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const evidence = parsed as Record<string, unknown>;
  const edgeRatePsiPerHour = evidence.edgeRatePsiPerHour;
  const lastEdgePsi = evidence.lastEdgePsi;
  if (typeof edgeRatePsiPerHour !== "number" || !Number.isFinite(edgeRatePsiPerHour)) return null;
  if (typeof lastEdgePsi !== "number" || !Number.isFinite(lastEdgePsi)) return null;

  return { edgeRatePsiPerHour, lastEdgePsi, sentAt: row.attemptedAt.getTime() };
}
