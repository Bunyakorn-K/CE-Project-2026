import { beforeEach, describe, expect, it } from "vitest";
import { db, initializeDatabase } from "./db";
import { aiTrace, chatTurn, evalResult, user } from "./schema";
import { purgeAll, TRACE_RETENTION_DAYS } from "./retention";

const OLD = new Date(Date.now() - (TRACE_RETENTION_DAYS + 2) * 86_400_000);
const FRESH = new Date(Date.now() - 60_000);

function trace(at: Date) {
  db.insert(aiTrace)
    .values({ id: `t-${at.getTime()}-${Math.random()}`, name: "chat.answer", status: "ok", durationMs: 1, attributes: "{}", createdAt: at })
    .run();
}

beforeEach(() => {
  initializeDatabase();
  db.delete(aiTrace).run();
  db.delete(evalResult).run();
  db.delete(chatTurn).run();
  db.insert(user)
    .values({ id: "u-ret", name: "r", email: "r@example.com", emailVerified: true, createdAt: FRESH, updatedAt: FRESH })
    .onConflictDoNothing()
    .run();
});

describe("purgeAll", () => {
  it("drops spans past the window and keeps this week", () => {
    trace(OLD);
    trace(FRESH);
    const summary = purgeAll(new Date());
    expect(summary.traces).toBe(1);
    expect(db.select().from(aiTrace).all()).toHaveLength(1);
  });

  it("leaves a transcript that is still inside its thirty days", () => {
    db.insert(chatTurn)
      .values({ id: "keep", lineUserId: "U1", userText: "a", answerText: "b", createdAt: FRESH })
      .run();
    db.insert(chatTurn)
      .values({ id: "drop", lineUserId: "U1", userText: "a", answerText: "b", createdAt: new Date(Date.now() - 40 * 86_400_000) })
      .run();
    const summary = purgeAll(new Date());
    expect(summary.turns).toBe(1);
    expect(db.select().from(chatTurn).all().map((row) => row.id)).toEqual(["keep"]);
  });

  it("keeps eval results for a quarter, not a week", () => {
    db.insert(evalResult)
      .values({
        id: "e1",
        runId: "r1",
        caseId: "c1",
        question: "q",
        answer: "a",
        score: 100,
        checks: "[]",
        latencyMs: 1,
        createdAt: new Date(Date.now() - 30 * 86_400_000)
      })
      .run();
    expect(purgeAll(new Date()).evals).toBe(0);
    expect(db.select().from(evalResult).all()).toHaveLength(1);
  });
});
