/**
 * The things a tap can do in chat: acknowledge an alert, ask for help.
 *
 * A postback is the only way a rich card can send a structured answer instead of a
 * sentence the model has to interpret — the user taps "รับทราบ" and the payload says
 * exactly which alert. Everything here is therefore a command, not a prompt: it is
 * parsed, authorised and executed by code, and the model never sees it.
 *
 * The authorisation rule is the same one the HTTP route uses, re-run from scratch:
 * a postback payload is user-supplied data, so the alert id in it proves nothing
 * about who is allowed to acknowledge that alert.
 */

import type { Principal } from "../access-store";
import { acknowledgeAlert } from "../access-store";
import { canAccessBranch } from "../access-policy";
import { readAlertRows } from "../alert-detail";
import { shortBranchLabels } from "./branch-label";

export type ChatCommand =
  | { kind: "ack"; alertId: string }
  | { kind: "help" }
  /** `pref:branch:<id>` sets the remembered branch; `pref:clear` forgets everything. */
  | { kind: "pref"; action: "branch"; branchId: string }
  | { kind: "pref"; action: "clear" }
  /** A tap on "มีประโยชน์" / "ไม่ตรงคำถาม" under an answer. */
  | { kind: "feedback"; rating: "up" | "down"; turnId: string }
  | { kind: "unknown"; raw: string };

/**
 * `ack:<irisAlertId>` / `help`. An alert id contains colons of its own
 * (`gas:gas_run_a_pressure:declining:2026-11-09T14`), so the prefix is split once
 * and the rest is the id verbatim.
 */
export function parsePostbackData(data: string | undefined | null): ChatCommand {
  const raw = (data ?? "").trim();
  if (raw === "help") return { kind: "help" };
  if (raw.startsWith("ack:")) {
    const alertId = raw.slice("ack:".length).trim();
    return alertId ? { kind: "ack", alertId } : { kind: "unknown", raw };
  }
  if (raw.startsWith("fb:")) {
    // `fb:up:<uuid>` — a turn id has no colons of its own, unlike an alert id.
    const [, rating, turnId] = raw.split(":");
    if ((rating === "up" || rating === "down") && turnId) return { kind: "feedback", rating, turnId };
    return { kind: "unknown", raw };
  }
  if (raw === "pref:clear") return { kind: "pref", action: "clear" };
  if (raw.startsWith("pref:branch:")) {
    const branchId = raw.slice("pref:branch:".length).trim();
    return branchId ? { kind: "pref", action: "branch", branchId } : { kind: "unknown", raw };
  }
  return { kind: "unknown", raw };
}

export type AckOutcome =
  | { ok: true; alertId: string; branchId: string | null }
  | { ok: false; reason: "not_found" | "forbidden"; alertId: string };

/**
 * Acknowledge one alert on behalf of the person who tapped.
 *
 * Only someone who received that alert, or who holds a grant covering its branch,
 * may acknowledge it — checked here rather than trusted from the payload.
 */
export function acknowledgeFromChat(input: {
  alertId: string;
  principal: Principal;
  lineUserId: string;
}): AckOutcome {
  const rows = readAlertRows(input.alertId);
  if (rows.length === 0) return { ok: false, reason: "not_found", alertId: input.alertId };

  const asRecipient = rows.some((row) => row.lineUserId === input.lineUserId);
  // A row with no branch is tenant-wide, so only an owner grant covers it.
  const asStaff = rows.some((row) =>
    row.branchId === null
      ? input.principal.grants.some((grant) => grant.role === "owner")
      : canAccessBranch(input.principal.grants, row.branchId)
  );
  if (!asRecipient && !asStaff) return { ok: false, reason: "forbidden", alertId: input.alertId };

  acknowledgeAlert({
    irisAlertId: input.alertId,
    userId: input.principal.user.id,
    note: "acknowledged in LINE chat"
  });

  return { ok: true, alertId: input.alertId, branchId: rows[0]?.branchId ?? null };
}

/** What a successful acknowledgement says: done, and what it did *not* do. */
export function acknowledgementReply(outcome: Extract<AckOutcome, { ok: true }>): string {
  return [
    "รับทราบแล้ว",
    `alert: ${outcome.alertId}`,
    "หมายเหตุ: การรับทราบหยุดแจ้งซ้ำเฉพาะ alert นี้ ถ้าเหตุยังเกิดอยู่ ชั่วโมงถัดไปจะแจ้งใหม่"
  ].join("\n");
}

export function refusalReply(outcome: Extract<AckOutcome, { ok: false }>): string {
  if (outcome.reason === "not_found") {
    return "ไม่พบ alert นี้ในระบบ อาจถูกลบหรือรหัสไม่ถูกต้อง";
  }
  return "คุณไม่มีสิทธิ์รับทราบ alert ของสาขานี้";
}

/**
 * The help answer, built from the same definitions the rich menu uses so the two
 * cannot disagree about what the bot can do.
 */
export function helpText(branchLabels: string[], menuLabels: string[]): string {
  const lines = [
    "ผู้ช่วย LaundryTwin ตอบจากข้อมูลจริงของร้าน — ไม่เดาตัวเลข",
    "",
    "ตัวอย่างที่ถามได้:",
    "- ภาพรวมวันนี้เป็นยังไง",
    "- รอบซักเมื่อวานเท่าไหร่",
    "- เครื่องไหนไม่ได้ใช้งานนานแล้ว",
    "- ช่วงเวลาไหนคนน้อยที่สุด"
  ];
  if (branchLabels.length > 0) {
    lines.push("", `สาขาที่คุณเข้าถึง: ${branchLabels.join(", ")}`);
  }
  if (menuLabels.length > 0) {
    lines.push("", `เมนูลัดในแผงด้านล่าง: ${menuLabels.join(" · ")}`);
  }
  lines.push(
    "",
    "คำสั่งที่บอทจำได้:",
    `- “${SET_BRANCH_PROMPT}” — เลือกสาขาประจำไว้ใช้ทุกครั้ง`,
    `- “${FORGET_BRANCH_PROMPT}” — ลืมที่จำไว้`,
    "- “รับทราบ” บนการ์ดแจ้งเตือน — ปิดการเตือนของชั่วโมงนั้น"
  );
  lines.push("", "ถ้าต้องการตัวเลขที่ละเอียดขึ้น เปิดแอปจากปุ่มในเมนูได้เลย");
  return lines.join("\n");
}

/** The free-form welcome a new follower gets (a follow event carries a reply token). */
export function welcomeText(branchLabels: string[]): string {
  const lines = [
    "ยินดีต้อนรับสู่ LaundryTwin",
    "ผมช่วยดูข้อมูลร้านให้ได้: รายได้ รอบซัก สถานะเครื่อง และช่วงเวลาที่คนน้อย",
    "",
    "ลองพิมพ์: ภาพรวมวันนี้เป็นยังไง"
  ];
  if (branchLabels.length === 0) {
    lines.push("", "บัญชีนี้ยังไม่ได้รับสิทธิ์ — พิมพ์ว่า 'ขอสิทธิ์ใช้งาน' เพื่อให้ผู้ดูแลอนุมัติ");
  }
  return lines.join("\n");
}

// ---- remembered preferences ----

/** The text the person can type (or tap) to see the branch choices. */
export const SET_BRANCH_PROMPT = "ตั้งสาขาประจำ";

export function isSetBranchRequest(text: string): boolean {
  const normalised = text.trim().replace(/\s+/g, " ");
  return normalised === SET_BRANCH_PROMPT || normalised === "สาขาประจำ";
}

/** The picker: one postback button per branch the person may see. */
export function branchChoiceReplies(branches: { branchId: string; branchName: string }[]): {
  label: string;
  data: string;
}[] {
  const shown = branches.slice(0, 13);
  // The same shortening the picker uses: two branches of one franchise differ at the
  // end of their name, and LINE keeps only the first 20 characters of a label.
  const labels = shortBranchLabels(shown.map((branch) => branch.branchName));
  return shown.map((branch, index) => ({
    label: labels[index],
    data: `pref:branch:${branch.branchId}`
  }));
}

export function branchPickerText(branches: { branchName: string }[]): string {
  if (branches.length === 0) {
    return "ยังไม่พบสาขาที่คุณเข้าถึงได้ — ลองติดต่อผู้ดูแลระบบ";
  }
  return [
    "เลือกสาขาประจำของคุณจากปุ่มด้านล่าง",
    "หลังจากนี้ ถามว่า “ภาพรวมวันนี้” บอทจะใช้สาขานี้ก่อน โดยไม่ต้องบอกซ้ำ",
    "(เปลี่ยนหรือลืมได้ทุกเมื่อ — พิมพ์ “ลืมสาขาประจำ” หรือกดปุ่ม “ลืมสาขา”)"
  ].join("\n");
}

export function rememberedBranchText(branchName: string): string {
  return `จำไว้แล้ว: สาขาประจำคือ ${branchName} — ถาม “ภาพรวมวันนี้” ได้เลย ไม่ต้องระบุสาขาซ้ำ`;
}

export function forgottenText(cleared: number): string {
  return cleared > 0 ? "ลืมสาขาประจำแล้ว" : "ยังไม่มีอะไรให้ลืม — ไม่เคยตั้งสาขาประจำไว้";
}

export function rememberedStateText(branchName: string | null): string {
  return branchName
    ? `สาขาประจำของคุณ: ${branchName}`
    : `ยังไม่ได้ตั้งสาขาประจำ — พิมพ์ “${SET_BRANCH_PROMPT}” เพื่อเลือก`;
}

export const FORGET_BRANCH_PROMPT = "ลืมสาขาประจำ";

export function isForgetBranchRequest(text: string): boolean {
  const normalised = text.trim().replace(/\s+/g, " ");
  return normalised === FORGET_BRANCH_PROMPT || normalised === "ลืมสาขา";
}
