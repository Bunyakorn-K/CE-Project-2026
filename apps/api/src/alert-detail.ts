/**
 * Reading one alert back out of the notification table.
 *
 * WHY THIS IS A READ OF `alert_notification` AND NOT OF A SOURCE. The alert that
 * a reader taps in LINE is the alert that was sent, and the only durable copy of
 * it is the notification row — title, rendered message, evidence, delivery state.
 * Re-deriving it from IRIS or the warehouse would answer a different question
 * ("what does the source say now") than the one the reader is asking ("what did
 * you tell me, and why").
 *
 * One alert has one row per recipient. The rows carry identical content, so the
 * caller authorises against all of them (was I a recipient, or am I an owner for
 * this branch) and then returns the row it is allowed to see.
 */

import { eq } from "drizzle-orm";
import { db } from "./db";
import { alertNotification, liffIdentity } from "./schema";

export type AlertDetailRow = {
  id: string;
  branchId: string | null;
  machineId: string | null;
  /** Kept for authorisation only; it is another user's platform id. */
  lineUserId: string;
  severity: string;
  title: string;
  message: string;
  evidence: Record<string, unknown>;
  status: string;
  attemptedAt: string;
  deliveredAt: string | null;
  error: string | null;
};

/** The public shape: the recipient's platform id is stripped before it leaves. */
export type AlertDetail = Omit<AlertDetailRow, "lineUserId">;

function parseEvidence(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A row whose evidence will not parse is still a real alert. Returning the
    // message and the delivery state with empty evidence is honest; throwing here
    // would hide a sent alert from the reader because one column is malformed.
    return {};
  }
}

function toRow(record: typeof alertNotification.$inferSelect): AlertDetailRow {
  return {
    id: record.irisAlertId,
    branchId: record.branchId ?? null,
    machineId: record.machineId ?? null,
    lineUserId: record.lineUserId,
    severity: record.severity,
    title: record.title,
    message: record.message,
    evidence: parseEvidence(record.evidence),
    status: record.status,
    attemptedAt: record.attemptedAt.toISOString(),
    deliveredAt: record.deliveredAt ? record.deliveredAt.toISOString() : null,
    error: record.error ?? null
  };
}

/** Every recipient row for one alert id; empty means the id is unknown to us. */
export function readAlertRows(irisAlertId: string): AlertDetailRow[] {
  return db
    .select()
    .from(alertNotification)
    .where(eq(alertNotification.irisAlertId, irisAlertId))
    .all()
    .map(toRow);
}

export function toPublicAlert(row: AlertDetailRow): AlertDetail {
  const { lineUserId: _lineUserId, ...rest } = row;
  return rest;
}

/** The caller's LINE id, when they have ever signed in through LIFF. */
export function lineUserIdForUser(userId: string): string | null {
  const row = db
    .select({ lineUserId: liffIdentity.lineUserId })
    .from(liffIdentity)
    .where(eq(liffIdentity.userId, userId))
    .get();
  return row?.lineUserId ?? null;
}
