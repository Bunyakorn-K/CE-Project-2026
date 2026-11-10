/**
 * Alert delivery settings, editable by an owner.
 *
 * WHY THESE MOVED OUT OF THE ENVIRONMENT. The re-notify floor and the monthly
 * cap depend on how noisy the shop is this week and how many messages the LINE
 * plan allows — not on how the code was built. As env vars, changing 12 hours to
 * 6 meant a redeploy, which is the wrong cost for a number an owner should be
 * able to reason about while looking at the usage.
 *
 * The environment is still the *initial* default (so an existing deployment keeps
 * behaving as configured), and the stored row wins once it exists.
 *
 * Ranges are enforced here rather than in the form, because the API is the only
 * place that can promise them: a floor of 0 would notify on every sweep, and a
 * budget of 10,000 would spend a plan that does not exist.
 */

import { eq } from "drizzle-orm";
import { db } from "./db";
import { alertSettings, auditLog } from "./schema";
import { randomUUID } from "node:crypto";
import { configuredBudget, configuredRenotifyMs } from "./alert-budget";
import { resolveAuditActor } from "./ai-audit";

export type AlertSettingsPublic = {
  renotifyHours: number;
  monthlyBudget: number;
  updatedAt: number | null;
  /** Where the current values came from, so the UI can say so. */
  source: "stored" | "environment";
};

export const RENOTIFY_HOURS_MIN = 1;
export const RENOTIFY_HOURS_MAX = 168; // a week
export const MONTHLY_BUDGET_MIN = 0;
export const MONTHLY_BUDGET_MAX = 1000;

export type AlertSettingsInput = {
  renotifyHours?: number;
  monthlyBudget?: number;
};

function defaultsFromEnvironment(): { renotifyHours: number; monthlyBudget: number } {
  return {
    renotifyHours: Math.round(configuredRenotifyMs() / (60 * 60 * 1000)),
    monthlyBudget: configuredBudget()
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** The stored row, or the environment's defaults when nothing has been saved. */
export function readAlertSettings(): AlertSettingsPublic {
  const row = db.select().from(alertSettings).where(eq(alertSettings.id, "default")).get();
  if (!row) {
    return { ...defaultsFromEnvironment(), updatedAt: null, source: "environment" };
  }
  return {
    renotifyHours: row.renotifyHours,
    monthlyBudget: row.monthlyBudget,
    updatedAt: row.updatedAt.getTime(),
    source: "stored"
  };
}

/**
 * Save, clamping to the allowed range and auditing the change.
 *
 * The audit row records the previous and the new values: "who turned the alerts
 * down to once a day" is a question that gets asked after an incident, and the
 * settings row alone cannot answer it.
 */
export function saveAlertSettings(input: AlertSettingsInput, actorUserId: string | null): AlertSettingsPublic {
  const previous = readAlertSettings();
  const next = {
    renotifyHours: clamp(
      input.renotifyHours ?? previous.renotifyHours,
      RENOTIFY_HOURS_MIN,
      RENOTIFY_HOURS_MAX
    ),
    monthlyBudget: clamp(
      input.monthlyBudget ?? previous.monthlyBudget,
      MONTHLY_BUDGET_MIN,
      MONTHLY_BUDGET_MAX
    )
  };
  const now = new Date();
  // The actor may be a principal that was never persisted (a dev bypass, or a
  // session whose user row is gone). Both columns are foreign keys, so an
  // unresolvable id becomes null rather than failing the save.
  const actor = resolveAuditActor(actorUserId).actorUserId;

  db.insert(alertSettings)
    .values({
      id: "default",
      renotifyHours: next.renotifyHours,
      monthlyBudget: next.monthlyBudget,
      updatedByUserId: actor,
      updatedAt: now,
      createdAt: now
    })
    .onConflictDoUpdate({
      target: alertSettings.id,
      set: {
        renotifyHours: next.renotifyHours,
        monthlyBudget: next.monthlyBudget,
        updatedByUserId: actor,
        updatedAt: now
      }
    })
    .run();

  db.insert(auditLog)
    .values({
      id: randomUUID(),
      actorUserId: actor,
      action: "alert.settings_updated",
      target: "alert_settings",
      detail: JSON.stringify({
        from: { renotifyHours: previous.renotifyHours, monthlyBudget: previous.monthlyBudget },
        to: next
      }),
      createdAt: now
    })
    .run();

  return { ...next, updatedAt: now.getTime(), source: "stored" };
}

/** The floor the engine should use, in milliseconds. */
export function effectiveRenotifyMs(): number {
  return readAlertSettings().renotifyHours * 60 * 60 * 1000;
}

/** The cap the engine should use. */
export function effectiveMonthlyBudget(): number {
  return readAlertSettings().monthlyBudget;
}
