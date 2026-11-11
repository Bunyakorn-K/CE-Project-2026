import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, initializeDatabase } from "../db";
import { alertAcknowledgement, alertNotification, user } from "../schema";
import type { Principal } from "../access-store";
import {
  acknowledgeFromChat,
  acknowledgementReply,
  helpText,
  parsePostbackData,
  refusalReply,
  welcomeText
} from "./actions";

const ALERT = "gas:gas_run_a_pressure:declining:2026-11-09T14";
const OTHER = "gas:gas_run_b_pressure:declining:2026-11-09T14";

function notify(input: { alertId: string; lineUserId: string; branchId: string | null }) {
  db.insert(alertNotification)
    .values({
      id: `${input.alertId}:${input.lineUserId}`,
      irisAlertId: input.alertId,
      lineUserId: input.lineUserId,
      branchId: input.branchId,
      machineId: null,
      severity: "warning",
      title: "แรงดันตก",
      message: "แรงดันลดลง",
      evidence: "{}",
      status: "sent",
      attemptedAt: new Date(),
      deliveredAt: new Date()
    })
    .onConflictDoNothing()
    .run();
}

function principal(role: "owner" | "manager" | "technician", branchId: string | null): Principal {
  return {
    source: "liff",
    user: { id: `u-${role}`, name: role, email: `${role}@e.com` },
    grants: [{ id: `g-${role}`, role, branchId }]
  } as Principal;
}

beforeEach(() => {
  initializeDatabase();
  db.delete(alertNotification).where(eq(alertNotification.irisAlertId, ALERT)).run();
  db.delete(alertNotification).where(eq(alertNotification.irisAlertId, OTHER)).run();
  db.delete(alertAcknowledgement).where(eq(alertAcknowledgement.irisAlertId, ALERT)).run();
  db.delete(alertAcknowledgement).where(eq(alertAcknowledgement.irisAlertId, OTHER)).run();
  // `alert_acknowledgement.user_id` is a foreign key: an acknowledgement is always
  // attributed to a real account, never to a name from a payload.
  for (const [id, email] of [
    ["u-owner", "owner@e.com"],
    ["u-manager", "manager@e.com"],
    ["u-technician", "technician@e.com"]
  ]) {
    db.insert(user)
      .values({ id, name: id, email, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing()
      .run();
  }
});

describe("parsePostbackData", () => {
  it("reads the ack payload as a command, keeping the alert id intact", () => {
    // The id contains colons of its own; splitting on every colon would truncate it.
    expect(parsePostbackData(`ack:${ALERT}`)).toEqual({ kind: "ack", alertId: ALERT });
  });

  it("reads a feedback tap and keeps the turn id whole", () => {
    expect(parsePostbackData("fb:up:1f0c2e6a-1111-2222-3333-444455556666")).toEqual({
      kind: "feedback",
      rating: "up",
      turnId: "1f0c2e6a-1111-2222-3333-444455556666"
    });
    expect(parsePostbackData("fb:down:x")).toMatchObject({ kind: "feedback", rating: "down" });
    expect(parsePostbackData("fb:sideways:x")).toMatchObject({ kind: "unknown" });
    expect(parsePostbackData("fb:up:")).toMatchObject({ kind: "unknown" });
  });

  it("reads help and rejects anything it does not know", () => {
    expect(parsePostbackData("help")).toEqual({ kind: "help" });
    expect(parsePostbackData("ack:")).toMatchObject({ kind: "unknown" });
    expect(parsePostbackData(undefined)).toMatchObject({ kind: "unknown" });
    expect(parsePostbackData("branch:b1")).toMatchObject({ kind: "unknown" });
  });
});

describe("acknowledgeFromChat", () => {
  it("refuses an alert nobody was sent", () => {
    expect(acknowledgeFromChat({ alertId: "nope", principal: principal("owner", null), lineUserId: "U1" })).toEqual({
      ok: false,
      reason: "not_found",
      alertId: "nope"
    });
  });

  it("lets a recipient acknowledge their own alert", () => {
    notify({ alertId: ALERT, lineUserId: "U-recipient", branchId: "b1" });
    const outcome = acknowledgeFromChat({
      alertId: ALERT,
      principal: principal("technician", "b1"),
      lineUserId: "U-recipient"
    });
    expect(outcome.ok).toBe(true);
    const rows = db.select().from(alertAcknowledgement).where(eq(alertAcknowledgement.irisAlertId, ALERT)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("u-technician");
  });

  it("lets a manager of that branch acknowledge, but not a manager of another", () => {
    notify({ alertId: ALERT, lineUserId: "U-someone-else", branchId: "b1" });

    const outsider = acknowledgeFromChat({
      alertId: ALERT,
      principal: principal("manager", "b2"),
      lineUserId: "U-manager-b2"
    });
    expect(outsider).toEqual({ ok: false, reason: "forbidden", alertId: ALERT });

    const insider = acknowledgeFromChat({
      alertId: ALERT,
      principal: principal("manager", "b1"),
      lineUserId: "U-manager-b1"
    });
    expect(insider.ok).toBe(true);
  });

  it("is idempotent — tapping twice leaves one row", () => {
    notify({ alertId: ALERT, lineUserId: "U-recipient", branchId: "b1" });
    const input = { alertId: ALERT, principal: principal("owner", null), lineUserId: "U-recipient" };
    acknowledgeFromChat(input);
    acknowledgeFromChat(input);
    expect(db.select().from(alertAcknowledgement).where(eq(alertAcknowledgement.irisAlertId, ALERT)).all()).toHaveLength(
      1
    );
  });

  it("says what an acknowledgement does and does not do", () => {
    notify({ alertId: ALERT, lineUserId: "U-recipient", branchId: "b1" });
    const outcome = acknowledgeFromChat({
      alertId: ALERT,
      principal: principal("owner", null),
      lineUserId: "U-recipient"
    });
    if (!outcome.ok) throw new Error("expected ok");
    const text = acknowledgementReply(outcome);
    expect(text).toContain("รับทราบแล้ว");
    expect(text).toContain(ALERT);
    // The card told them the same thing; the reply must not promise silence.
    expect(text).toContain("ชั่วโมงถัดไปจะแจ้งใหม่");
  });

  it("explains a refusal rather than failing silently", () => {
    expect(refusalReply({ ok: false, reason: "not_found", alertId: "x" })).toContain("ไม่พบ alert");
    expect(refusalReply({ ok: false, reason: "forbidden", alertId: "x" })).toContain("ไม่มีสิทธิ์");
  });
});

describe("help and welcome", () => {
  it("offers examples and the caller's scope", () => {
    const text = helpText(["สาขา A"], ["ภาพรวม", "แชทกับ AI"]);
    expect(text).toContain("ภาพรวมวันนี้เป็นยังไง");
    expect(text).toContain("สาขาที่คุณเข้าถึง: สาขา A");
    expect(text).toContain("เมนูลัด");
  });

  it("tells a follower without access what to do", () => {
    expect(welcomeText([])).toContain("ขอสิทธิ์ใช้งาน");
    expect(welcomeText(["ทุกสาขา"])).not.toContain("ขอสิทธิ์ใช้งาน");
  });
});
