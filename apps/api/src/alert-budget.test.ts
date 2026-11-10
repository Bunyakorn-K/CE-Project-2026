import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, initializeDatabase } from "./db";
import { alertNotification } from "./schema";
import {
  DEFAULT_MONTHLY_BUDGET,
  budgetState,
  configuredBudget,
  configuredRenotifyMs,
  monthKey,
  monthStart,
  monthlySentCount
} from "./alert-budget";

const inserted: string[] = [];

function seedSent(deliveredAt: Date, status: "sent" | "failed" = "sent") {
  const id = randomUUID();
  db.insert(alertNotification)
    .values({
      id,
      irisAlertId: `test:${id}`,
      lineUserId: "U-test",
      branchId: null,
      machineId: null,
      severity: "warning",
      title: "t",
      message: "m",
      evidence: "{}",
      status,
      cooldownKey: `k:${id}`,
      attemptedAt: deliveredAt,
      deliveredAt: status === "sent" ? deliveredAt : null,
      error: null
    })
    .run();
  inserted.push(id);
}

beforeEach(() => {
  initializeDatabase();
});

afterEach(() => {
  for (const id of inserted.splice(0)) {
    db.$client.prepare("DELETE FROM alert_notification WHERE id = ?").run(id);
  }
});

describe("month boundaries", () => {
  it("starts the month at UTC midnight on the first", () => {
    expect(monthStart(new Date("2026-11-09T16:25:00.000Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(monthKey(new Date("2026-11-09T16:25:00.000Z"))).toBe("2026-11");
    expect(monthKey(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01");
  });
});

describe("monthlySentCount", () => {
  it("counts only delivered messages inside the month", () => {
    const now = new Date("2026-11-09T12:00:00.000Z");
    const before = monthlySentCount(now);

    seedSent(new Date("2026-11-02T00:00:00.000Z"));
    seedSent(new Date("2026-11-09T11:59:00.000Z"));
    // Outside the month, and a failure that never reached LINE: neither is a
    // message the allowance was charged for.
    seedSent(new Date("2026-10-31T23:59:00.000Z"));
    seedSent(new Date("2026-11-05T00:00:00.000Z"), "failed");

    expect(monthlySentCount(now)).toBe(before + 2);
  });
});

describe("budgetState", () => {
  it("reports what is left and never goes negative", () => {
    const now = new Date("2026-11-09T12:00:00.000Z");
    const used = monthlySentCount(now);

    // Chat pushes are stated, not inherited: another test file writes `chat_turn`
    // rows to the same SQLite file in parallel.
    const roomy = budgetState(now, used + 5, 0);
    expect(roomy.remaining).toBe(5);
    expect(roomy.month).toBe("2026-11");

    const spent = budgetState(now, Math.max(0, used - 1), 0);
    expect(spent.remaining).toBe(0);
  });
});

describe("configuration", () => {
  it("defaults to 200 of LINE's 300, leaving room for chat fallbacks", () => {
    expect(configuredBudget({})).toBe(DEFAULT_MONTHLY_BUDGET);
    expect(DEFAULT_MONTHLY_BUDGET).toBeLessThan(300);
  });

  it("reads the cap from the environment and refuses nonsense", () => {
    expect(configuredBudget({ ALERT_MONTHLY_BUDGET: "120" })).toBe(120);
    expect(configuredBudget({ ALERT_MONTHLY_BUDGET: "0" })).toBe(0);
    expect(configuredBudget({ ALERT_MONTHLY_BUDGET: "abc" })).toBe(DEFAULT_MONTHLY_BUDGET);
    expect(configuredBudget({ ALERT_MONTHLY_BUDGET: "-5" })).toBe(DEFAULT_MONTHLY_BUDGET);
  });

  it("re-notifies every 12 hours by default, not every hour", () => {
    // 1 hour × 2 channels × 24 h × 30 d = 1,440 messages against a 300 allowance.
    expect(configuredRenotifyMs({})).toBe(12 * 60 * 60 * 1000);
    expect(configuredRenotifyMs({ ALERT_RENOTIFY_HOURS: "6" })).toBe(6 * 60 * 60 * 1000);
    expect(configuredRenotifyMs({ ALERT_RENOTIFY_HOURS: "0" })).toBe(12 * 60 * 60 * 1000);
    expect(configuredRenotifyMs({ ALERT_RENOTIFY_HOURS: "nope" })).toBe(12 * 60 * 60 * 1000);
  });
});
