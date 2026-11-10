import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, initializeDatabase } from "./db";
import {
  accessGrant,
  alertAcknowledgement,
  alertNotification,
  digestRecipient,
  digestSent,
  digestSettings,
  liffIdentity,
  user
} from "./schema";
import {
  addDigestRecipient,
  buildDigest,
  digestDueAt,
  listDigestRecipients,
  listLineUsers,
  previousShopDay,
  readDigestSettings,
  removeDigestRecipient,
  runDigest,
  saveDigestSettings,
  shopDay
} from "./digest";
import type { ClickHouseExecutor } from "./analytics/clickhouse";

const OWNER_LINE = "U-digest-owner";
const TECH_LINE = "U-digest-tech";
const OWNER_USER = "u-digest-owner";
const TECH_USER = "u-digest-tech";
const NOW = new Date("2026-11-10T01:00:00Z"); // 08:00 Bangkok

function seedPerson(lineUserId: string, userId: string, role: "owner" | "technician", branchId: string | null) {
  db.insert(user)
    .values({ id: userId, name: userId, email: `${userId}@example.com`, emailVerified: true, createdAt: NOW, updatedAt: NOW })
    .onConflictDoNothing()
    .run();
  db.insert(liffIdentity)
    .values({ lineUserId, userId, displayName: userId, updatedAt: NOW })
    .onConflictDoNothing()
    .run();
  db.insert(accessGrant)
    .values({
      id: `grant-${userId}-${role}`,
      userId,
      role,
      branchId,
      grantedByUserId: userId,
      grantedAt: NOW,
      revokedAt: null
    })
    .onConflictDoNothing()
    .run();
}

function notify(day: string, irisAlertId: string, branchId: string | null) {
  db.insert(alertNotification)
    .values({
      id: `${irisAlertId}:${day}`,
      irisAlertId,
      lineUserId: OWNER_LINE,
      branchId,
      machineId: null,
      severity: "warning",
      title: "แจ้งเตือน",
      message: "ข้อความ",
      evidence: "{}",
      status: "sent",
      attemptedAt: new Date(`${day}T02:00:00+07:00`),
      deliveredAt: new Date(`${day}T02:00:00+07:00`)
    })
    .onConflictDoNothing()
    .run();
}

beforeEach(() => {
  initializeDatabase();
  db.delete(digestSettings).run();
  db.delete(digestRecipient).run();
  db.delete(digestSent).run();
  db.delete(alertNotification).run();
  db.delete(alertAcknowledgement).run();
  db.delete(liffIdentity).run();
  db.delete(accessGrant).run();
  db.delete(user).run();
});

describe("settings", () => {
  it("is off, at 07:00, until an owner saves it", () => {
    const settings = readDigestSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.sendHour).toBe(7);
    expect(settings.sendMinute).toBe(0);
    expect(settings.source).toBe("default");
  });

  it("keeps the hour inside a real day and remembers who changed it", () => {
    // `updated_by_user_id` is a foreign key: the audit trail names a real account.
    seedPerson(OWNER_LINE, OWNER_USER, "owner", null);
    saveDigestSettings({ enabled: true, sendHour: 31, sendMinute: -5 }, OWNER_USER);
    const settings = readDigestSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.sendHour).toBe(23);
    expect(settings.sendMinute).toBe(0);
    expect(settings.source).toBe("stored");
  });
});

describe("recipients", () => {
  it("only accepts an account that is linked to LINE and holds a role", () => {
    seedPerson(OWNER_LINE, OWNER_USER, "owner", null);
    expect(addDigestRecipient(OWNER_LINE)).toEqual({ ok: true });
    expect(addDigestRecipient("U-not-linked")).toEqual({ ok: false, reason: "not-linked" });

    // Linked but with every grant revoked: the digest carries revenue.
    db.delete(accessGrant).run();
    expect(addDigestRecipient(OWNER_LINE)).toEqual({ ok: false, reason: "no-access" });

    seedPerson(TECH_LINE, TECH_USER, "technician", "b1");
    expect(listLineUsers().map((person) => person.lineUserId)).toContain(TECH_LINE);
    expect(listDigestRecipients()).toHaveLength(1);
  });

  it("removes one without touching the others", () => {
    seedPerson(OWNER_LINE, OWNER_USER, "owner", null);
    seedPerson(TECH_LINE, TECH_USER, "technician", "b1");
    addDigestRecipient(OWNER_LINE);
    addDigestRecipient(TECH_LINE);
    expect(removeDigestRecipient(OWNER_LINE)).toBe(true);
    expect(listDigestRecipients().map((row) => row.lineUserId)).toEqual([TECH_LINE]);
  });
});

describe("days and due time", () => {
  it("uses the shop's day, not UTC's", () => {
    // 18:30 UTC on the 9th is the 10th in Bangkok.
    expect(shopDay(new Date("2026-11-09T18:30:00Z"))).toBe("2026-11-10");
    expect(previousShopDay(new Date("2026-11-10T01:00:00Z"))).toBe("2026-11-09");
  });

  it("is due at the hour the owner picked, in Bangkok", () => {
    expect(digestDueAt(NOW, 7, 0).toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect(digestDueAt(NOW, 0, 30).toISOString()).toBe("2026-11-09T17:30:00.000Z");
  });
});

describe("buildDigest", () => {
  it("sums the day's revenue and counts the alerts, and stays one message", async () => {
    const clickhouse: ClickHouseExecutor = (async () => [
      {
        date: "2026-11-09",
        branchId: "b1",
        branchName: "แม่โจ้",
        revenueSatang: "180000",
        cycles: "40",
        avgDurationMin: "34",
        synthCount: "0",
        totalCount: "40"
      }
    ]) as unknown as ClickHouseExecutor;

    notify("2026-11-09", "gas:gas_run_a:declining:2026-11-09T08", "b1");
    notify("2026-11-09", "gas:gas_run_b:declining:2026-11-09T09", "b1");

    const { text, stats } = await buildDigest({
      day: "2026-11-09",
      allowedBranches: null,
      maySeeRevenue: true,
      clickhouse
    });

    expect(stats.source).toBe("ok");
    expect(stats.revenueBaht).toBe(1800);
    expect(stats.cycles).toBe(40);
    expect(stats.alerts.total).toBe(2);
    expect(text).toContain("1,800 บาท");
    expect(text).toContain("แรงดันแก๊ส ×2");
    expect(text.length).toBeLessThanOrEqual(900);
  });

  it("hides revenue from a role that may not see it, but keeps the cycles", async () => {
    const clickhouse: ClickHouseExecutor = (async () => [
      {
        date: "2026-11-09",
        branchId: "b1",
        branchName: "แม่โจ้",
        revenueSatang: "180000",
        cycles: "40",
        avgDurationMin: "34",
        synthCount: "0",
        totalCount: "40"
      }
    ]) as unknown as ClickHouseExecutor;

    const { text } = await buildDigest({
      day: "2026-11-09",
      allowedBranches: ["b1"],
      maySeeRevenue: false,
      clickhouse
    });
    expect(text).not.toContain("1,800 บาท");
    expect(text).toContain("40 รอบซัก");
  });

  it("still sends the alerts when the warehouse is down, and says so", async () => {
    const failing = (async () => {
      throw new Error("unavailable");
    }) as unknown as ClickHouseExecutor;
    notify("2026-11-09", "gas:gas_run_a:declining:2026-11-09T08", "b1");

    const { text, stats } = await buildDigest({
      day: "2026-11-09",
      allowedBranches: null,
      maySeeRevenue: true,
      clickhouse: failing
    });
    expect(stats.source).toBe("unavailable");
    expect(text).toContain("ดึงข้อมูลคลังไม่สำเร็จ");
    expect(text).toContain("แจ้งเตือน 1 ครั้ง");
  });

  it("ignores alerts from another branch when the reader is scoped", async () => {
    notify("2026-11-09", "gas:gas_run_a:declining:2026-11-09T08", "b1");
    notify("2026-11-09", "gas:gas_run_b:declining:2026-11-09T09", "b2");
    const { stats } = await buildDigest({ day: "2026-11-09", allowedBranches: ["b1"], maySeeRevenue: false });
    expect(stats.alerts.total).toBe(1);
  });
});

describe("runDigest", () => {
  const adapter = () => ({ sendText: vi.fn().mockResolvedValue("push") });

  it("does nothing at all while it is off", async () => {
    seedPerson(OWNER_LINE, OWNER_USER, "owner", null);
    addDigestRecipient(OWNER_LINE);
    const line = adapter();
    const summary = await runDigest({ adapter: line as never, now: NOW });
    expect(summary.state).toBe("disabled");
    expect(line.sendText).not.toHaveBeenCalled();
  });

  it("waits for the hour the owner set", async () => {
    seedPerson(OWNER_LINE, OWNER_USER, "owner", null);
    addDigestRecipient(OWNER_LINE);
    saveDigestSettings({ enabled: true, sendHour: 9, sendMinute: 0 });
    const line = adapter();
    const summary = await runDigest({ adapter: line as never, now: NOW }); // 08:00 Bangkok
    expect(summary.state).toBe("not-yet");
    expect(line.sendText).not.toHaveBeenCalled();
  });

  it("sends once, covers the previous day, and never twice", async () => {
    seedPerson(OWNER_LINE, OWNER_USER, "owner", null);
    addDigestRecipient(OWNER_LINE);
    saveDigestSettings({ enabled: true, sendHour: 7, sendMinute: 0 });
    const line = adapter();

    const first = await runDigest({ adapter: line as never, now: NOW });
    expect(first.state).toBe("ran");
    expect(first.day).toBe("2026-11-09");
    expect(first.sent).toBe(1);
    expect(line.sendText).toHaveBeenCalledTimes(1);

    // A retry five minutes later must not send a second message.
    const second = await runDigest({ adapter: line as never, now: new Date(NOW.getTime() + 300_000) });
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);
    expect(line.sendText).toHaveBeenCalledTimes(1);
  });

  it("builds the message without sending anything in a dry run", async () => {
    seedPerson(OWNER_LINE, OWNER_USER, "owner", null);
    addDigestRecipient(OWNER_LINE);
    saveDigestSettings({ enabled: true, sendHour: 7, sendMinute: 0 });
    const line = adapter();
    const summary = await runDigest({ adapter: line as never, now: NOW, dryRun: true });
    expect(summary.preview).toHaveLength(1);
    expect(summary.preview[0].text).toContain("สรุปวัน");
    expect(line.sendText).not.toHaveBeenCalled();
    expect(db.select().from(digestSent).all()).toHaveLength(0);
  });

  it("retries the next day after a failure instead of closing the day", async () => {
    seedPerson(OWNER_LINE, OWNER_USER, "owner", null);
    addDigestRecipient(OWNER_LINE);
    saveDigestSettings({ enabled: true, sendHour: 7, sendMinute: 0 });
    const flaky = { sendText: vi.fn().mockRejectedValueOnce(new Error("LINE 500")) };

    const first = await runDigest({ adapter: flaky as never, now: NOW });
    expect(first.failed).toBe(1);

    const second = await runDigest({ adapter: flaky as never, now: new Date(NOW.getTime() + 300_000) });
    expect(second.sent).toBe(1);
    expect(second.skipped).toBe(0);
    expect(db.select().from(digestSent).all()).toHaveLength(1);
    expect(db.select().from(digestSent).all()[0].status).toBe("sent");
  });

  it("records a failure instead of pretending it was sent", async () => {
    seedPerson(OWNER_LINE, OWNER_USER, "owner", null);
    addDigestRecipient(OWNER_LINE);
    saveDigestSettings({ enabled: true, sendHour: 7, sendMinute: 0 });
    const failing = { sendText: vi.fn().mockRejectedValue(new Error("LINE 500")) };
    const summary = await runDigest({ adapter: failing as never, now: NOW });
    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(0);
    expect(db.select().from(digestSent).all()[0].status).toBe("failed");
  });

  it("says so when nobody has been added yet", async () => {
    saveDigestSettings({ enabled: true });
    const summary = await runDigest({ adapter: adapter() as never, now: NOW });
    expect(summary.state).toBe("no-recipients");
  });
});
