// Telling someone their access was approved.
//
// The approval happened in the backoffice, on a screen the person who asked cannot
// see. Without a message the request simply… stops being pending, and the person who
// was told "รอผู้ดูแลอนุมัติ" has no way to know that it was. So the approval pushes
// one message to the LINE user who asked.
//
// This costs a push: there is no reply token, because the tap that triggers it comes
// from the admin's browser, not from the requester. So it is recorded in
// `alert_notification` like every other outbound message, and therefore counted
// against the same monthly budget — a rare message, but not an invisible one.
//
// It is best-effort by construction: `notifyAccessApproved` never throws, because an
// approval that already happened in the database must not be reported as failed just
// because LINE refused the notice.

import { messagingApi } from "@line/bot-sdk";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { alertNotification } from "../schema";

export type ApprovalNotice = {
  requestId: string;
  lineUserId: string;
  role: string;
  branchName: string | null;
};

const ROLE_LABEL: Record<string, string> = {
  owner: "เจ้าของ (ทุกสาขา)",
  manager: "ผู้จัดการสาขา",
  technician: "ช่างเทคนิค"
};

/** What the person reads. No markdown: LINE shows it literally. */
export function approvalText(notice: ApprovalNotice): string {
  const role = ROLE_LABEL[notice.role] ?? notice.role;
  const scope = notice.branchName ? `สาขา ${notice.branchName}` : "ทุกสาขาที่คุณดูแล";
  return [
    "อนุมัติสิทธิ์เข้าใช้งานแล้ว",
    "",
    `บทบาท: ${role}`,
    `ขอบเขต: ${scope}`,
    "",
    "ลองพิมพ์ได้เลย:",
    "• “ภาพรวมวันนี้เป็นยังไง”",
    "• “เครื่องไหนมีปัญหาบ้าง”",
    "",
    "ถ้าต้องการดูสาขาอื่น พิมพ์ “ตั้งสาขาประจำ” แล้วเลือกจากปุ่มได้"
  ].join("\n");
}

export type NotifyOutcome = "sent" | "failed" | "skipped";

type PushText = (lineUserId: string, text: string) => Promise<void>;

/**
 * Send the notice once, and record the attempt either way.
 *
 * The row is written before the send, so a crash between the two leaves `sending`
 * rather than nothing — the same shape the alert engine uses, and the reason the
 * budget can be counted from rows instead of a counter.
 */
export async function notifyAccessApproved(
  notice: ApprovalNotice,
  deps: { push?: PushText; token?: string | undefined; now?: Date } = {}
): Promise<NotifyOutcome> {
  const text = approvalText(notice);
  const now = deps.now ?? new Date();
  const rowId = randomUUID();
  const token = deps.token ?? process.env.LINE_CHANNEL_ACCESS_TOKEN;

  const push: PushText | null =
    deps.push ??
    (token
      ? async (lineUserId, body) => {
          const client = new messagingApi.MessagingApiClient({ channelAccessToken: token });
          await client.pushMessage({ to: lineUserId, messages: [{ type: "text", text: body }] });
        }
      : null);

  // No token means the deployment cannot push at all — not a failure of this
  // approval, so nothing is recorded and nothing is claimed.
  if (!push) return "skipped";

  try {
    db.insert(alertNotification)
      .values({
        id: rowId,
        irisAlertId: `access:${notice.requestId}`,
        lineUserId: notice.lineUserId,
        branchId: null,
        machineId: null,
        severity: "info",
        title: "อนุมัติสิทธิ์เข้าใช้งานแล้ว",
        message: text,
        evidence: JSON.stringify({ requestId: notice.requestId, role: notice.role }),
        status: "sending",
        cooldownKey: `access:${notice.requestId}`,
        attemptedAt: now,
        deliveredAt: null,
        error: null
      })
      .run();
  } catch {
    // A duplicate row for the same request means the notice was already attempted;
    // the unique index is the idempotency guard, and re-approving is impossible
    // anyway because the request is no longer pending.
    return "skipped";
  }

  try {
    await push(notice.lineUserId, text);
    db.update(alertNotification)
      .set({ status: "sent", deliveredAt: new Date() })
      .where(eq(alertNotification.id, rowId))
      .run();
    return "sent";
  } catch (error) {
    db.update(alertNotification)
      .set({ status: "failed", error: error instanceof Error ? error.message : "unknown" })
      .where(eq(alertNotification.id, rowId))
      .run();
    return "failed";
  }
}
