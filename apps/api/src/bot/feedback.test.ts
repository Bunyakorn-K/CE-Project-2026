import { beforeEach, describe, expect, it } from "vitest";
import { db, initializeDatabase } from "../db";
import { chatFeedback, chatTurn } from "../schema";
import { feedbackCounts, recordFeedback, thanksText } from "./feedback";

const USER = "U-fb-user";
const TURN = "turn-abc";

function seedTurn(id = TURN, lineUserId = USER) {
  db.insert(chatTurn)
    .values({
      id,
      lineUserId,
      userText: "ถาม",
      answerText: "ตอบ",
      model: "m",
      createdAt: new Date()
    })
    .onConflictDoNothing()
    .run();
}

beforeEach(() => {
  initializeDatabase();
  db.delete(chatFeedback).run();
  db.delete(chatTurn).run();
});

describe("recordFeedback", () => {
  it("records a thumb against the turn", () => {
    seedTurn();
    expect(recordFeedback({ turnId: TURN, lineUserId: USER, rating: "up" })).toBe("recorded");
    expect(db.select().from(chatFeedback).all()).toHaveLength(1);
  });

  it("ignores a second tap on the same answer", () => {
    seedTurn();
    recordFeedback({ turnId: TURN, lineUserId: USER, rating: "up" });
    expect(recordFeedback({ turnId: TURN, lineUserId: USER, rating: "up" })).toBe("duplicate");
    expect(db.select().from(chatFeedback).all()).toHaveLength(1);
  });

  it("treats a different second tap as a correction, not a second vote", () => {
    seedTurn();
    recordFeedback({ turnId: TURN, lineUserId: USER, rating: "up" });
    expect(recordFeedback({ turnId: TURN, lineUserId: USER, rating: "down" })).toBe("recorded");
    const rows = db.select().from(chatFeedback).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe("down");
  });

  it("refuses a turn that belongs to someone else", () => {
    seedTurn(TURN, "U-someone-else");
    expect(recordFeedback({ turnId: TURN, lineUserId: USER, rating: "up" })).toBe("unknown-turn");
    expect(db.select().from(chatFeedback).all()).toHaveLength(0);
  });

  it("refuses a turn that does not exist", () => {
    expect(recordFeedback({ turnId: "nope", lineUserId: USER, rating: "up" })).toBe("unknown-turn");
  });

  it("counts what people said since a moment", () => {
    seedTurn("t1");
    seedTurn("t2");
    seedTurn("t3");
    recordFeedback({ turnId: "t1", lineUserId: USER, rating: "up" });
    recordFeedback({ turnId: "t2", lineUserId: USER, rating: "up" });
    recordFeedback({ turnId: "t3", lineUserId: USER, rating: "down" });
    expect(feedbackCounts(new Date(Date.now() - 60_000))).toEqual({ up: 2, down: 1 });
    expect(feedbackCounts(new Date(Date.now() + 60_000))).toEqual({ up: 0, down: 0 });
  });

  it("thanks differently for a down vote, without arguing", () => {
    expect(thanksText("up")).toContain("ขอบคุณ");
    expect(thanksText("down")).toContain("ปรับการตอบ");
  });
});
