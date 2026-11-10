/**
 * LaundryTwin LINE alert engine (MVP pillar 5).
 *
 * Turns IRIS alerts into proactive LINE pushes with three guarantees:
 *  - Idempotency: one notification per (alert, recipient), enforced by a
 *    UNIQUE(iris_alert_id, line_user_id) constraint, so a re-fetched alert is
 *    never pushed twice.
 *  - Cooldown: repeat occurrences of the same alert class (branch + rule +
 *    severity) are skipped within ALERT_COOLDOWN_MS after the last successful
 *    push, so a flapping sensor cannot spam recipients.
 *  - Audit: every attempt is recorded in alert_notification with status,
 *    evidence, and timestamps; cooldown skips go to audit_log.
 *
 * Recipients are LINE-linked users (liff_identity) with an active access grant
 * (access_grant) whose role matches the alert severity and whose branch
 * assignment covers the alert branch (branchId null = all branches).
 *
 * The engine never fabricates a delivery: if the LINE channel is not
 * configured the attempt is recorded as failed and retried on the next sweep.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { buildAlertFlex } from "./alert-flex";
import { budgetState } from "./alert-budget";
import { effectiveMonthlyBudget, effectiveRenotifyMs } from "./alert-settings";
import { db } from "./db";
import { accessGrant, alertNotification, auditLog, liffIdentity } from "./schema";
import type { Role } from "./access-policy";
import type { IrisAlert } from "./iris-read-client";

export type LineRecipient = {
  userId: string;
  role: Role;
  branchId: string | null;
  lineUserId: string;
};

export type AlertEngineDeps = {
  /**
   * LINE push adapter. `sendText` must resolve only when LINE accepted the
   * message; `sendFlex` is optional and, when present, is preferred — a card is
   * the same information in a readable shape.
   */
  adapter: {
    // Resolves with how it left ("reply" is free, "push" is charged); the alert
    // path ignores the value, the bot records it.
    sendText(userId: string, text: string): Promise<unknown>;
    sendFlex?(userId: string, altText: string, contents: Record<string, unknown>): Promise<unknown>;
  };
  /** When false (no LINE_CHANNEL_ACCESS_TOKEN), attempts are recorded as failed instead of sent. */
  adapterAvailable?: boolean;
  now?: () => Date;
  cooldownMs?: number;
  staleSendingMs?: number;
  severityRoles?: Record<string, Role[]>;
};

export type AlertSweepSummary = {
  scanned: number;
  recipients: number;
  sent: number;
  deduplicated: number;
  cooldown: number;
  noRecipients: number;
  failed: number;
  acknowledged: number;
  /**
   * Alerts held back because the month's LINE allowance is spent. Counted
   * separately from `cooldown` because the two need different responses: a
   * cooldown is the rule working, a budget stop is the deployment running out of
   * messages and someone has to decide what to do about it.
   */
  suppressedBudget: number;
};

/**
 * The re-notify floor is read per sweep, not captured at import: an owner can
 * change it in the backoffice and the next sweep must honour it without a
 * redeploy. Twelve hours by default — an hourly alert on two channels is 1,440
 * messages a month against a 300-message allowance.
 */
const DEFAULT_STALE_SENDING_MS = 5 * 60 * 1000; // in-flight claim older than this is retried

const DEFAULT_SEVERITY_ROLES: Record<string, Role[]> = {
  critical: ["owner", "manager", "technician"],
  high: ["owner", "manager"],
  warning: ["owner", "manager"],
  info: ["owner"]
};

const FALLBACK_SEVERITY_ROLES: Role[] = ["owner", "manager"];

export function rolesForSeverity(severity: string, rules?: Record<string, Role[]>): Role[] {
  return (rules ?? DEFAULT_SEVERITY_ROLES)[severity.trim().toLowerCase()] ?? FALLBACK_SEVERITY_ROLES;
}

/** Cooldown key identifies the alert class, not the instance. */
export function cooldownKeyFor(alert: IrisAlert): string {
  return `${alert.branchId ?? "*"}:${alert.ruleId ?? "generic"}:${alert.severity.trim().toLowerCase()}`;
}


/**
 * The LIFF deep link for one alert, or null when the deployment does not know its
 * LIFF id.
 *
 * A card without a button still says everything that matters; a button pointing
 * at Nothing would be worse, so the env var is required rather than guessed from
 * the channel id (a Messaging API channel id is not a LIFF app id).
 */
export function alertDetailUrl(irisAlertId: string): string | null {
  const liffId = process.env.LIFF_ID;
  if (!liffId) return null;
  return `https://liff.line.me/${liffId}/alerts/${encodeURIComponent(irisAlertId)}`;
}

export function formatAlertMessage(alert: IrisAlert): string {
  const lines = [`🔔 LaundryTwin แจ้งเตือน (${alert.severity.toUpperCase()})`, alert.title];
  if (alert.detail) lines.push(alert.detail);
  const meta: string[] = [];
  if (alert.branchId) meta.push(`สาขา: ${alert.branchId}`);
  if (alert.machineId) meta.push(`เครื่อง: ${alert.machineId}`);
  if (alert.detectedAt) meta.push(`เวลา: ${alert.detectedAt}`);
  if (meta.length > 0) lines.push(meta.join(" | "));
  return lines.join("\n");
}

function listLineRecipients(): LineRecipient[] {
  return db
    .select({
      userId: accessGrant.userId,
      role: accessGrant.role,
      branchId: accessGrant.branchId,
      lineUserId: liffIdentity.lineUserId
    })
    .from(accessGrant)
    .innerJoin(liffIdentity, eq(liffIdentity.userId, accessGrant.userId))
    .where(isNull(accessGrant.revokedAt))
    .all();
}

function recipientsForAlert(
  recipients: LineRecipient[],
  alert: IrisAlert,
  rules?: Record<string, Role[]>
): LineRecipient[] {
  const allowed = new Set(rolesForSeverity(alert.severity, rules));
  return recipients.filter(
    (recipient) => allowed.has(recipient.role) && (recipient.branchId === null || recipient.branchId === alert.branchId)
  );
}

function lastSentAtForKey(key: string): Date | null {
  const row = db
    .select({ attemptedAt: alertNotification.attemptedAt })
    .from(alertNotification)
    .where(and(eq(alertNotification.cooldownKey, key), eq(alertNotification.status, "sent")))
    .orderBy(desc(alertNotification.attemptedAt))
    .limit(1)
    .get();
  return row ? row.attemptedAt : null;
}

/**
 * Atomically claim a notification slot for (alert, recipient).
 * Returns the row id when the caller may (re)send, or null when the alert was
 * already handled for this recipient. Failed rows and stale in-flight rows are
 * reclaimed so a transient LINE error or a crashed sweep self-heals.
 */
function claimNotification(input: {
  alert: IrisAlert;
  lineUserId: string;
  cooldownKey: string;
  now: Date;
  staleSendingMs: number;
}): { rowId: string } | null {
  const { alert, lineUserId, cooldownKey, now, staleSendingMs } = input;
  const rowId = randomUUID();
  const inserted = db
    .insert(alertNotification)
    .values({
      id: rowId,
      irisAlertId: alert.id,
      lineUserId,
      branchId: alert.branchId,
      machineId: alert.machineId,
      severity: alert.severity,
      title: alert.title,
      message: formatAlertMessage(alert),
      evidence: JSON.stringify(alert.evidence ?? {}),
      status: "sending",
      cooldownKey,
      attemptedAt: now,
      deliveredAt: null,
      error: null
    })
    .onConflictDoNothing()
    .run();
  if (inserted.changes > 0) return { rowId };

  const existing = db
    .select({ id: alertNotification.id, status: alertNotification.status, attemptedAt: alertNotification.attemptedAt })
    .from(alertNotification)
    .where(and(eq(alertNotification.irisAlertId, alert.id), eq(alertNotification.lineUserId, lineUserId)))
    .get();
  if (!existing) return null;

  const retryable =
    existing.status === "failed" ||
    (existing.status === "sending" && existing.attemptedAt.getTime() < now.getTime() - staleSendingMs);
  if (!retryable) return null;

  db.update(alertNotification)
    .set({ status: "sending", attemptedAt: now, error: null })
    .where(eq(alertNotification.id, existing.id))
    .run();
  return { rowId: existing.id };
}

function markOutcome(rowId: string, now: Date, status: "sent" | "failed", error?: unknown) {
  db.update(alertNotification)
    .set({
      status,
      deliveredAt: status === "sent" ? now : null,
      error: status === "failed" ? (error instanceof Error ? error.message : String(error)) : null
    })
    .where(eq(alertNotification.id, rowId))
    .run();
}

function recordCooldownSkip(alert: IrisAlert, key: string) {
  db.insert(auditLog)
    .values({
      id: randomUUID(),
      actorUserId: null,
      action: "alert.skipped_cooldown",
      target: alert.id,
      detail: JSON.stringify({ cooldownKey: key, ruleId: alert.ruleId, severity: alert.severity }),
      createdAt: new Date()
    })
    .run();
}

function recordBudgetSkip(alert: IrisAlert, key: string, budget: { month: string; used: number; cap: number }) {
  db.insert(auditLog)
    .values({
      id: randomUUID(),
      actorUserId: null,
      action: "alert.suppressed_budget",
      target: alert.id,
      detail: JSON.stringify({ cooldownKey: key, ruleId: alert.ruleId, severity: alert.severity, ...budget }),
      createdAt: new Date()
    })
    .run();
}

function locallyAcknowledgedIds(alertIds: string[]): Set<string> {
  if (alertIds.length === 0) return new Set();
  const placeholders = alertIds.map(() => "?").join(", ");
  const rows = db.$client
    .prepare(`SELECT iris_alert_id FROM alert_acknowledgement WHERE iris_alert_id IN (${placeholders})`)
    .all(...alertIds) as Array<{ iris_alert_id: string }>;
  return new Set(rows.map((row) => row.iris_alert_id));
}

export async function runAlertSweep(alerts: IrisAlert[], deps: AlertEngineDeps): Promise<AlertSweepSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const cooldownMs = deps.cooldownMs ?? effectiveRenotifyMs();
  const staleSendingMs = deps.staleSendingMs ?? DEFAULT_STALE_SENDING_MS;
  const adapterAvailable = deps.adapterAvailable ?? true;
  const allRecipients = listLineRecipients();
  const acknowledgedIds = locallyAcknowledgedIds(alerts.map((alert) => alert.id));

  const summary: AlertSweepSummary = {
    scanned: 0,
    recipients: 0,
    sent: 0,
    deduplicated: 0,
    cooldown: 0,
    suppressedBudget: 0,
    noRecipients: 0,
    failed: 0,
    acknowledged: 0
  };

  for (const alert of alerts) {
    summary.scanned += 1;
    if (alert.acknowledgedAt || acknowledgedIds.has(alert.id)) {
      summary.acknowledged += 1;
      continue;
    }

    const recipients = recipientsForAlert(allRecipients, alert, deps.severityRoles);
    if (recipients.length === 0) {
      summary.noRecipients += 1;
      continue;
    }

    const key = cooldownKeyFor(alert);
    const lastSent = lastSentAtForKey(key);
    if (lastSent && now.getTime() - lastSent.getTime() < cooldownMs) {
      summary.cooldown += 1;
      recordCooldownSkip(alert, key);
      continue;
    }

    // The month's allowance, checked after the cooldown so a suppressed alert is
    // never counted twice, and recorded rather than dropped: an alert that was
    // not sent because the budget ran out is a fact someone has to see.
    const budget = budgetState(now, effectiveMonthlyBudget());
    if (budget.remaining <= 0) {
      summary.suppressedBudget += 1;
      recordBudgetSkip(alert, key, budget);
      continue;
    }

    for (const recipient of recipients) {
      summary.recipients += 1;
      const claim = claimNotification({ alert, lineUserId: recipient.lineUserId, cooldownKey: key, now, staleSendingMs });
      if (!claim) {
        summary.deduplicated += 1;
        continue;
      }
      if (!adapterAvailable) {
        markOutcome(claim.rowId, now, "failed", "LINE_CHANNEL_ACCESS_TOKEN is not configured");
        summary.failed += 1;
        continue;
      }
      try {
        const card = buildAlertFlex(alert, { detailUrl: alertDetailUrl(alert.id) });
        if (typeof deps.adapter.sendFlex === "function") {
          await deps.adapter.sendFlex(recipient.lineUserId, card.altText, card.contents);
        } else {
          await deps.adapter.sendText(recipient.lineUserId, formatAlertMessage(alert));
        }
        markOutcome(claim.rowId, now, "sent");
        summary.sent += 1;
      } catch (error) {
        markOutcome(claim.rowId, now, "failed", error);
        summary.failed += 1;
      }
    }
  }
  return summary;
}
