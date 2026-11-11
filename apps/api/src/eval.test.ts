import { beforeEach, describe, expect, it } from "vitest";
import { db, initializeDatabase } from "./db";
import { evalCase, evalResult, evalRun } from "./schema";
import { CANONICAL_CASES, ensureEvalCases, listCases, listRuns, runEval, scoreAnswer } from "./eval";

beforeEach(() => {
  initializeDatabase();
  db.delete(evalResult).run();
  db.delete(evalRun).run();
  db.delete(evalCase).run();
});

describe("scoreAnswer", () => {
  const good = "ภาพรวมวันนี้: รายได้ 3,120 บาท จาก 77 รอบซัก เฉลี่ย 34 นาทีต่อรอบครับ";

  it("passes an answer with numbers", () => {
    const { score, checks } = scoreAnswer({ answer: good, latencyMs: 5_000 });
    expect(score).toBe(100);
    expect(checks.every((check) => check.passed)).toBe(true);
  });

  it("fails an apology, which is what a broken gateway produces", () => {
    const { score, checks } = scoreAnswer({
      answer: "ขออภัย เกิดข้อผิดพลาดในการประมวลผล ลองถามใหม่อีกครั้งครับ",
      latencyMs: 1_000
    });
    expect(score).toBeLessThan(100);
    expect(checks.find((check) => check.name === "answered")?.passed).toBe(false);
  });

  it("accepts an explicit no-data answer as grounded", () => {
    const { checks } = scoreAnswer({
      answer: "ยังไม่มีข้อมูลของวันนี้ในคลัง ข้อมูลมักล่าช้าประมาณ 24 ชั่วโมงครับ",
      latencyMs: 4_000
    });
    expect(checks.find((check) => check.name === "grounded")?.passed).toBe(true);
  });

  it("marks an answer slow past thirty seconds", () => {
    const { checks } = scoreAnswer({ answer: good, latencyMs: 79_224 });
    expect(checks.find((check) => check.name === "timely")?.passed).toBe(false);
  });

  it("checks the branch only when the case names one", () => {
    const withName = scoreAnswer({ answer: good, expectContains: "แม่โจ้", latencyMs: 1_000 });
    expect(withName.checks.find((check) => check.name === "mentions")?.passed).toBe(false);
    expect(scoreAnswer({ answer: good, latencyMs: 1_000 }).checks.map((c) => c.name)).not.toContain("mentions");
  });
});

describe("the set", () => {
  it("seeds the canonical questions once", () => {
    expect(ensureEvalCases()).toBe(CANONICAL_CASES.length);
    expect(ensureEvalCases()).toBe(CANONICAL_CASES.length);
    expect(listCases()).toHaveLength(CANONICAL_CASES.length);
    expect(listCases()[0].question).toContain("ภาพรวมวันนี้");
  });
});

describe("runEval", () => {
  const answer = (text: string) => async () => ({
    text,
    inputTokens: 120,
    outputTokens: 60,
    model: "test-model",
    promptVersion: "v-test"
  });

  it("records a run with its results and a score per case", async () => {
    const summary = await runEval({
      limit: 2,
      answer: answer("รายได้วันนี้ 1,200 บาท จาก 31 รอบซัก เฉลี่ย 34 นาที")
    });

    expect(summary.total).toBe(2);
    expect(summary.model).toBe("test-model");
    expect(summary.passed).toBe(2);
    expect(summary.averageScore).toBe(100);
    expect(db.select().from(evalResult).all()).toHaveLength(2);
    expect(db.select().from(evalRun).all()).toHaveLength(1);
  });

  it("keeps the answers that failed, so the next run has something to compare", async () => {
    const summary = await runEval({
      limit: 1,
      answer: answer("ขออภัย เกิดข้อผิดพลาดในการประมวลผล ลองถามใหม่อีกครั้ง")
    });
    expect(summary.passed).toBe(0);
    const rows = db.select().from(evalResult).all();
    expect(rows[0].score).toBeLessThan(75);
    expect(rows[0].answer).toContain("ขออภัย");
  });

  it("lists runs newest first with their pass counts", async () => {
    await runEval({ limit: 1, answer: answer("รายได้วันนี้ 1,200 บาท จาก 31 รอบซัก เฉลี่ย 34 นาที") });
    await runEval({ limit: 1, answer: answer("ขออภัย ไม่สามารถประมวลผลได้ในขณะนี้ โปรดลองอีกครั้งภายหลัง") });
    const runs = listRuns(5);
    expect(runs).toHaveLength(2);
    expect(runs[0].averageScore).toBeLessThan(runs[1].averageScore);
  });
});
