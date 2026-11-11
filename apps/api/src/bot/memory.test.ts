import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, initializeDatabase } from "../db";
import { chatTurn } from "../schema";
import {
  CHAT_MEMORY_TURNS,
  CHAT_TURN_RETENTION_MS,
  allTurns,
  appendTurn,
  purgeExpiredChatTurns,
  recentTurns,
  turnCount
} from "./memory";

const ALICE = "U-memory-alice";
const BOB = "U-memory-bob";

function turn(lineUserId: string, question: string, answer: string, at?: Date) {
  appendTurn({ lineUserId, userText: question, answerText: answer, model: "m", at });
}

beforeEach(() => {
  initializeDatabase();
  db.delete(chatTurn).where(eq(chatTurn.lineUserId, ALICE)).run();
  db.delete(chatTurn).where(eq(chatTurn.lineUserId, BOB)).run();
});

describe("appendTurn / recentTurns", () => {
  it("returns the turns oldest first, as question then answer", () => {
    turn(ALICE, "ภาพรวมวันนี้", "ขายได้ 40 รอบ");
    turn(ALICE, "แล้วเมื่อวานล่ะ", "เมื่อวาน 31 รอบ");

    expect(recentTurns(ALICE)).toEqual([
      { role: "user", content: "ภาพรวมวันนี้" },
      { role: "assistant", content: "ขายได้ 40 รอบ" },
      { role: "user", content: "แล้วเมื่อวานล่ะ" },
      { role: "assistant", content: "เมื่อวาน 31 รอบ" }
    ]);
  });

  it("keeps the newest turns, not the first ones", () => {
    // The bug this guards: an ascending query with a limit returns the START of the
    // conversation, which is the opposite of memory — the bot would answer about
    // last week while the user is still on today.
    for (let index = 1; index <= CHAT_MEMORY_TURNS + 4; index += 1) {
      turn(ALICE, `คำถาม ${index}`, `คำตอบ ${index}`, new Date(2026, 0, index));
    }
    const turns = recentTurns(ALICE);
    expect(turns).toHaveLength(CHAT_MEMORY_TURNS * 2);
    expect(turns[0].content).toBe(`คำถาม ${CHAT_MEMORY_TURNS + 4 - (CHAT_MEMORY_TURNS - 1)}`);
    expect(turns[turns.length - 1].content).toBe(`คำตอบ ${CHAT_MEMORY_TURNS + 4}`);
  });

  it("honours a smaller limit and refuses a non-positive one", () => {
    turn(ALICE, "a", "b", new Date(2026, 0, 1));
    turn(ALICE, "c", "d", new Date(2026, 0, 2));
    expect(recentTurns(ALICE, 1)).toEqual([
      { role: "user", content: "c" },
      { role: "assistant", content: "d" }
    ]);
    expect(recentTurns(ALICE, 0)).toEqual([]);
  });

  it("keeps conversations apart by LINE user", () => {
    turn(ALICE, "ของอลิซ", "ตอบอลิซ");
    turn(BOB, "ของบ็อบ", "ตอบบ็อบ");
    expect(recentTurns(ALICE).map((entry) => entry.content)).toEqual(["ของอลิซ", "ตอบอลิซ"]);
    expect(recentTurns(BOB).map((entry) => entry.content)).toEqual(["ของบ็อบ", "ตอบบ็อบ"]);
  });

  it("records how the answer was produced", () => {
    appendTurn({
      lineUserId: ALICE,
      userText: "ถาม",
      answerText: "ตอบ",
      model: "test-model",
      steps: 3,
      toolCalls: 2,
      latencyMs: 1234,
      delivered: "push"
    });
    const [row] = allTurns(ALICE);
    expect(row).toMatchObject({
      model: "test-model",
      steps: 3,
      toolCalls: 2,
      latencyMs: 1234,
      delivered: "push"
    });
  });
});

describe("purgeExpiredChatTurns", () => {
  it("drops turns past the retention window and keeps the rest", () => {
    const now = new Date("2026-11-10T00:00:00Z");
    const old = new Date(now.getTime() - CHAT_TURN_RETENTION_MS - 60_000);
    const fresh = new Date(now.getTime() - 60_000);

    turn(ALICE, "เก่า", "เก่า", old);
    turn(ALICE, "ใหม่", "ใหม่", fresh);

    // The purge is global by design, and another test file may have written an old
    // row to the same table in parallel; what matters is Alice's window.
    expect(purgeExpiredChatTurns(now)).toBeGreaterThanOrEqual(1);
    expect(turnCount(ALICE)).toBe(1);
    expect(recentTurns(ALICE)[0].content).toBe("ใหม่");
  });

  it("returns zero when nothing is old enough", () => {
    turn(ALICE, "ใหม่", "ใหม่", new Date());
    expect(purgeExpiredChatTurns()).toBe(0);
  });
});

describe("memory skips answers that came from a failing tool", () => {
  it("keeps the row but leaves it out of the context", () => {
    const user = `U-mem-${Date.now()}`;
    appendTurn({ lineUserId: user, userText: "รายได้เท่าไหร่", answerText: "ดึงไม่ได้ (Revenue tool disabled)", toolError: true });
    appendTurn({ lineUserId: user, userText: "แล้วรอบซักล่ะ", answerText: "38 รอบ" });

    const context = recentTurns(user);
    expect(context.map((turn) => turn.content)).toEqual(["แล้วรอบซักล่ะ", "38 รอบ"]);
    expect(turnCount(user)).toBe(2);
    expect(allTurns(user).map((row) => row.toolError)).toEqual([1, 0]);
  });
});
