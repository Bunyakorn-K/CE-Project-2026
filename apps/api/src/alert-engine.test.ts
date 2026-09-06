import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { initializeDatabase, db } from "./db";
import {
  accessGrant,
  alertAcknowledgement,
  alertNotification,
  auditLog,
  liffIdentity,
  user
} from "./schema";
import {
  cooldownKeyFor,
  formatAlertMessage,
  rolesForSeverity,
  runAlertSweep,
  type AlertEngineDeps,
  type LineRecipient
} from "./alert-engine";
import type { Role } from "./access-policy";
import type { IrisAlert } from "./iris-read-client";

const testAlertIds: string[] = [];
const testUserIds: string[] = [];
const testLineUserIds: string[] = [];

function seedRecipient(over: { role: Role; branchId: string | null }): LineRecipient & { userId: string } {
  const userId = randomUUID();
  const lineUserId = `U-test-${randomUUID().slice(0, 8)}`;
  const now = new Date();
  db.insert(user)
    .values({ id: userId, name: "Test User", email: `alert-test-${userId}@laundrytwin.test`, emailVerified: false, image: null, createdAt: now, updatedAt: now })
    .run();
  db.insert(accessGrant)
    .values({ id: randomUUID(), userId, role: over.role, branchId: over.branchId, grantedByUserId: null, grantedAt: now })
    .run();
  db.insert(liffIdentity).values({ lineUserId, userId, displayName: "Test User", updatedAt: now }).run();
  testUserIds.push(userId);
  testLineUserIds.push(lineUserId);
  return { userId, role: over.role, branchId: over.branchId, lineUserId };
}

function makeAlert(over: Partial<IrisAlert> = {}): IrisAlert {
  const alert: IrisAlert = {
    id: randomUUID(),
    branchId: "B1",
    machineId: "M1",
    ruleId: "R1",
    ruleUpdatedAt: null,
    ruleVersion: "1",
    severity: "warning",
    title: "อุณหภูมิสูงผิดปกติ",
    detail: "เครื่อง M1 อุณหภูมิ 95C",
    tags: [],
    evidence: { temperatureC: 95 },
    detectedAt: new Date().toISOString(),
    acknowledgedAt: null,
    coverage: {},
    ...over
  };
  testAlertIds.push(alert.id);
  return alert;
}

function deps(over: Partial<AlertEngineDeps> = {}): AlertEngineDeps {
  return {
    adapter: { sendText: vi.fn().mockResolvedValue(undefined) },
    now: () => new Date("2026-09-06T12:00:00.000Z"),
    ...over
  };
}

function notificationRows(irisAlertId?: string) {
  const base = db.select().from(alertNotification);
  return irisAlertId ? base.where(eq(alertNotification.irisAlertId, irisAlertId)).all() : base.all();
}

function cleanupTestData() {
  if (testAlertIds.length > 0) {
    const placeholders = testAlertIds.map(() => "?").join(", ");
    db.$client.prepare(`DELETE FROM alert_notification WHERE iris_alert_id IN (${placeholders})`).run(...testAlertIds);
    db.$client.prepare(`DELETE FROM alert_acknowledgement WHERE iris_alert_id IN (${placeholders})`).run(...testAlertIds);
    db.$client.prepare(`DELETE FROM audit_log WHERE target IN (${placeholders})`).run(...testAlertIds);
  }
  if (testLineUserIds.length > 0) {
    const placeholders = testLineUserIds.map(() => "?").join(", ");
    db.$client.prepare(`DELETE FROM alert_notification WHERE line_user_id IN (${placeholders})`).run(...testLineUserIds);
    db.$client.prepare(`DELETE FROM liff_identity WHERE line_user_id IN (${placeholders})`).run(...testLineUserIds);
  }
  if (testUserIds.length > 0) {
    const placeholders = testUserIds.map(() => "?").join(", ");
    db.$client.prepare(`DELETE FROM access_grant WHERE user_id IN (${placeholders})`).run(...testUserIds);
    db.$client.prepare(`DELETE FROM liff_identity WHERE user_id IN (${placeholders})`).run(...testUserIds);
    db.$client.prepare(`DELETE FROM user WHERE id IN (${placeholders})`).run(...testUserIds);
  }
  testAlertIds.length = 0;
  testUserIds.length = 0;
  testLineUserIds.length = 0;
}

beforeEach(() => {
  initializeDatabase();
});

afterEach(() => {
  cleanupTestData();
});

describe("rolesForSeverity", () => {
  it("maps severities to roles with a safe fallback", () => {
    expect(rolesForSeverity("critical")).toEqual(["owner", "manager", "technician"]);
    expect(rolesForSeverity("warning")).toEqual(["owner", "manager"]);
    expect(rolesForSeverity("info")).toEqual(["owner"]);
    expect(rolesForSeverity("unknown-severity")).toEqual(["owner", "manager"]);
    expect(rolesForSeverity("  CRITICAL ")).toEqual(["owner", "manager", "technician"]);
  });
});

describe("cooldownKeyFor", () => {
  it("keys on branch + rule + severity, not the instance", () => {
    const a = makeAlert({ branchId: "B1", ruleId: "R1", severity: "warning" });
    const b = makeAlert({ branchId: "B1", ruleId: "R1", severity: "warning" });
    const c = makeAlert({ branchId: "B2", ruleId: "R1", severity: "warning" });
    expect(cooldownKeyFor(a)).toBe("B1:R1:warning");
    expect(cooldownKeyFor(b)).toBe(cooldownKeyFor(a));
    expect(cooldownKeyFor(c)).not.toBe(cooldownKeyFor(a));
    expect(cooldownKeyFor(makeAlert({ branchId: null, ruleId: null }))).toBe("*:generic:warning");
  });
});

describe("formatAlertMessage", () => {
  it("includes severity, title, detail and machine metadata", () => {
    const message = formatAlertMessage(makeAlert());
    expect(message).toContain("LaundryTwin");
    expect(message).toContain("WARNING");
    expect(message).toContain("อุณหภูมิสูงผิดปกติ");
    expect(message).toContain("95C");
    expect(message).toContain("สาขา: B1");
    expect(message).toContain("เครื่อง: M1");
  });
});

describe("runAlertSweep", () => {
  it("sends only to LINE-linked recipients whose role and branch match the alert", async () => {
    const ownerB1 = seedRecipient({ role: "owner", branchId: "B1" });
    const managerB1 = seedRecipient({ role: "manager", branchId: "B1" });
    seedRecipient({ role: "technician", branchId: "B1" }); // warning excludes technicians
    seedRecipient({ role: "manager", branchId: "B2" }); // wrong branch
    seedRecipient({ role: "owner", branchId: null }); // tenant-wide owner also receives
    const sendText = vi.fn().mockResolvedValue(undefined);
    const alert = makeAlert({ severity: "warning", branchId: "B1" });

    const summary = await runAlertSweep([alert], deps({ adapter: { sendText } }));

    expect(sendText).toHaveBeenCalledTimes(3);
    const recipients = sendText.mock.calls.map((call) => call[0]);
    expect(recipients).toContain(ownerB1.lineUserId);
    expect(recipients).toContain(managerB1.lineUserId);
    expect(summary).toMatchObject({ scanned: 1, recipients: 3, sent: 3, failed: 0, noRecipients: 0 });
  });

  it("never pushes the same alert twice for the same recipient (idempotency)", async () => {
    const owner = seedRecipient({ role: "owner", branchId: "B1" });
    const sendText = vi.fn().mockResolvedValue(undefined);
    const alert = makeAlert();
    const later = () => new Date("2026-09-06T14:00:00.000Z"); // past the 1h cooldown window
    const afterCooldown = () => new Date("2026-09-06T16:00:00.000Z"); // 2h later: cooldown no longer shields it

    const first = await runAlertSweep([alert], deps({ adapter: { sendText }, now: later }));
    const second = await runAlertSweep([alert], deps({ adapter: { sendText }, now: afterCooldown }));

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.deduplicated).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(notificationRows(alert.id)).toHaveLength(1);
    expect(notificationRows(alert.id)[0].lineUserId).toBe(owner.lineUserId);
  });

  it("applies cooldown to repeat occurrences of the same alert class", async () => {
    seedRecipient({ role: "owner", branchId: "B1" });
    const sendText = vi.fn().mockResolvedValue(undefined);
    const t0 = () => new Date("2026-09-06T12:00:00.000Z");
    const withinWindow = () => new Date("2026-09-06T12:30:00.000Z");
    const afterWindow = () => new Date("2026-09-06T14:00:00.000Z");

    const first = await runAlertSweep([makeAlert()], deps({ adapter: { sendText }, now: t0 }));
    const second = await runAlertSweep([makeAlert()], deps({ adapter: { sendText }, now: withinWindow }));
    const third = await runAlertSweep([makeAlert()], deps({ adapter: { sendText }, now: afterWindow }));

    expect(first.sent).toBe(1);
    expect(second.cooldown).toBe(1);
    expect(second.sent).toBe(0);
    expect(third.sent).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("does not apply cooldown across different branches", async () => {
    seedRecipient({ role: "owner", branchId: null });
    const sendText = vi.fn().mockResolvedValue(undefined);
    const t0 = () => new Date("2026-09-06T12:00:00.000Z");
    const withinWindow = () => new Date("2026-09-06T12:30:00.000Z");

    await runAlertSweep([makeAlert({ branchId: "B1" })], deps({ adapter: { sendText }, now: t0 }));
    const otherBranch = await runAlertSweep([makeAlert({ branchId: "B2" })], deps({ adapter: { sendText }, now: withinWindow }));

    expect(otherBranch.sent).toBe(1);
  });

  it("skips alerts acknowledged upstream or locally", async () => {
    const recipient = seedRecipient({ role: "owner", branchId: "B1" });
    const sendText = vi.fn().mockResolvedValue(undefined);
    const upstream = makeAlert({ acknowledgedAt: "2026-09-06T11:00:00.000Z" });
    const local = makeAlert();
    db.insert(alertAcknowledgement)
      .values({ id: randomUUID(), irisAlertId: local.id, userId: recipient.userId, note: null, createdAt: new Date() })
      .run();

    const summary = await runAlertSweep([upstream, local], deps({ adapter: { sendText } }));

    expect(summary.acknowledged).toBe(2);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("records failed deliveries with the error and retries them on the next sweep", async () => {
    seedRecipient({ role: "owner", branchId: "B1" });
    const alert = makeAlert();
    const later = () => new Date("2026-09-06T14:00:00.000Z");
    const failing = { sendText: vi.fn().mockRejectedValue(new Error("LINE 500")) };
    const working = { sendText: vi.fn().mockResolvedValue(undefined) };

    const first = await runAlertSweep([alert], deps({ adapter: failing, now: later }));
    expect(first.failed).toBe(1);
    expect(notificationRows(alert.id)[0].status).toBe("failed");
    expect(notificationRows(alert.id)[0].error).toContain("LINE 500");

    const second = await runAlertSweep([alert], deps({ adapter: working, now: later }));
    expect(second.failed).toBe(0);
    expect(second.sent).toBe(1);
    expect(notificationRows(alert.id)[0].status).toBe("sent");
    expect(working.sendText).toHaveBeenCalledTimes(1);
  });

  it("retries a stale in-flight claim instead of dropping the alert", async () => {
    const owner = seedRecipient({ role: "owner", branchId: "B1" });
    const alert = makeAlert();
    const now = new Date("2026-09-06T12:00:00.000Z");
    db.insert(alertNotification)
      .values({
        id: randomUUID(),
        irisAlertId: alert.id,
        lineUserId: owner.lineUserId,
        branchId: alert.branchId,
        machineId: alert.machineId,
        severity: alert.severity,
        title: alert.title,
        message: formatAlertMessage(alert),
        evidence: "{}",
        status: "sending",
        cooldownKey: cooldownKeyFor(alert),
        attemptedAt: new Date(now.getTime() - 10 * 60 * 1000), // claimed 10 minutes ago
        deliveredAt: null,
        error: null
      })
      .run();
    const sendText = vi.fn().mockResolvedValue(undefined);

    const summary = await runAlertSweep([alert], deps({ adapter: { sendText }, now: () => now }));

    expect(summary.sent).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(notificationRows(alert.id)[0].status).toBe("sent");
  });

  it("marks attempts as failed when the LINE channel is not configured", async () => {
    seedRecipient({ role: "owner", branchId: "B1" });
    const alert = makeAlert();

    const summary = await runAlertSweep(
      [alert],
      deps({ adapterAvailable: false, adapter: { sendText: vi.fn() } })
    );

    expect(summary.failed).toBe(1);
    expect(notificationRows(alert.id)[0].status).toBe("failed");
    expect(notificationRows(alert.id)[0].error).toContain("LINE_CHANNEL_ACCESS_TOKEN");
  });

  it("counts alerts with no eligible recipients", async () => {
    const alert = makeAlert();
    const summary = await runAlertSweep([alert], deps({ adapter: { sendText: vi.fn() } }));
    expect(summary.noRecipients).toBe(1);
    expect(notificationRows()).toHaveLength(0);
  });

  it("stores the triggering evidence for traceability", async () => {
    seedRecipient({ role: "owner", branchId: "B1" });
    const alert = makeAlert({ evidence: { temperatureC: 95, doorStatus: "closed" } });
    await runAlertSweep([alert], deps({ adapter: { sendText: vi.fn().mockResolvedValue(undefined) } }));
    const row = notificationRows(alert.id)[0];
    expect(JSON.parse(row.evidence)).toEqual({ temperatureC: 95, doorStatus: "closed" });
  });

  it("supports custom severity role rules", async () => {
    const owner = seedRecipient({ role: "owner", branchId: "B1" });
    const manager = seedRecipient({ role: "manager", branchId: "B1" });
    const sendText = vi.fn().mockResolvedValue(undefined);
    const alert = makeAlert({ severity: "info" });
    const severityRoles: Record<string, Role[]> = { info: ["owner", "manager"] };

    const summary = await runAlertSweep([alert], deps({ adapter: { sendText }, severityRoles }));

    expect(summary.sent).toBe(2);
    const sentTo = sendText.mock.calls.map((call) => call[0]);
    expect(sentTo).toContain(owner.lineUserId);
    expect(sentTo).toContain(manager.lineUserId);
  });
});
