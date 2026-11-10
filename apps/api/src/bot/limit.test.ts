import { beforeEach, describe, expect, it } from "vitest";
import { db, initializeDatabase } from "../db";
import { chatTurn } from "../schema";
import {
  CHAT_DAILY_LIMIT,
  CHAT_HOURLY_LIMIT,
  chatEnabled,
  chatStats,
  evaluateChatLimit,
  hourStart,
  shopDayStart
} from "./limit";

const USER = "U-limit-user";
const OTHER = "U-limit-other";

function turn(lineUserId: string, at: Date, delivered: "reply" | "push" = "reply") {
  db.insert(chatTurn)
    .values({
      id: `${lineUserId}-${at.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      lineUserId,
      userText: "ถาม",
      answerText: "ตอบ",
      model: "test",
      delivered,
      createdAt: at
    })
    .run();
}

beforeEach(() => {
  initializeDatabase();
  db.delete(chatTurn).run();
});

describe("chatEnabled", () => {
  it("is on unless someone turns it off", () => {
    expect(chatEnabled({})).toBe(true);
    for (const value of ["false", "0", "off", "no", "FALSE"]) {
      expect(chatEnabled({ CHAT_ENABLED: value }), value).toBe(false);
    }
    expect(chatEnabled({ CHAT_ENABLED: "true" })).toBe(true);
  });
});

describe("shop day", () => {
  it("starts at Bangkok midnight, not UTC midnight", () => {
    // 18:30 UTC on the 9th is already the 10th in Bangkok (UTC+7).
    expect(shopDayStart(new Date("2026-11-09T18:30:00Z")).toISOString()).toBe("2026-11-09T17:00:00.000Z");
    expect(shopDayStart(new Date("2026-11-10T03:00:00Z")).toISOString()).toBe("2026-11-09T17:00:00.000Z");
  });

  it("rounds the hour boundary down", () => {
    expect(hourStart(new Date("2026-11-10T03:25:00Z")).toISOString()).toBe("2026-11-10T03:00:00.000Z");
  });
});

describe("evaluateChatLimit", () => {
  const now = new Date("2026-11-10T03:30:00Z");

  it("allows a conversation under the hourly limit", () => {
    turn(USER, new Date(now.getTime() - 60_000));
    expect(evaluateChatLimit({ lineUserId: USER, now })).toEqual({ allowed: true });
  });

  it("refuses the message after the hourly limit, and says when it lifts", () => {
    for (let index = 0; index < CHAT_HOURLY_LIMIT; index += 1) {
      turn(USER, new Date(now.getTime() - 60_000 - index * 1000));
    }
    const decision = evaluateChatLimit({ lineUserId: USER, now });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("expected refusal");
    expect(decision.reason).toBe("hourly");
    expect(decision.message).toContain(String(CHAT_HOURLY_LIMIT));
    expect(decision.message).toContain("กรุณาลองใหม่หลัง");
    expect(decision.retryAfterMinutes).toBeGreaterThan(0);
  });

  it("counts per person, not per shop", () => {
    for (let index = 0; index < CHAT_HOURLY_LIMIT; index += 1) {
      turn(OTHER, new Date(now.getTime() - 60_000 - index * 1000));
    }
    expect(evaluateChatLimit({ lineUserId: USER, now })).toEqual({ allowed: true });
  });

  it("ignores messages from the previous hour", () => {
    for (let index = 0; index < CHAT_HOURLY_LIMIT; index += 1) {
      turn(USER, new Date(now.getTime() - 90 * 60_000 - index * 1000));
    }
    expect(evaluateChatLimit({ lineUserId: USER, now })).toEqual({ allowed: true });
  });

  it("refuses everyone once the shop's day is used up", () => {
    for (let index = 0; index < CHAT_DAILY_LIMIT; index += 1) {
      turn(`U-bulk-${index % 7}`, new Date(now.getTime() - (index % 50) * 60_000));
    }
    const decision = evaluateChatLimit({ lineUserId: USER, now });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("expected refusal");
    expect(decision.reason).toBe("daily");
    expect(decision.message).toContain(String(CHAT_DAILY_LIMIT));
  });
});

describe("chatStats", () => {
  const now = new Date("2026-11-10T03:30:00Z");

  it("splits today's answers into reply and push, and counts the month's pushes", () => {
    turn(USER, new Date(now.getTime() - 60_000), "reply");
    turn(USER, new Date(now.getTime() - 120_000), "push");
    // Last month: counted in nothing but the table.
    turn(USER, new Date("2026-10-02T03:00:00Z"), "push");

    const stats = chatStats(now, {});
    expect(stats.turnsToday).toBe(2);
    expect(stats.repliesToday).toBe(1);
    expect(stats.pushesToday).toBe(1);
    expect(stats.pushesThisMonth).toBe(1);
    expect(stats.limits).toEqual({ hourly: CHAT_HOURLY_LIMIT, daily: CHAT_DAILY_LIMIT, enabled: true });
  });
});
