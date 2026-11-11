/**
 * The golden set, and the runner that replays it.
 *
 * WHY. On 2026-11-10 the gateway was switched and the assistant began answering about
 * 2026-07-01 — a date it invented — with an empty report. Nothing compared the new
 * model against the old one, so the first person to notice was the owner, in LINE.
 *
 * WHAT A RUN IS. The same questions, through the same pipeline, recorded: answer,
 * latency, tokens, and a rule-based score. Rule-based on purpose — an LLM judge adds a
 * second model whose opinions also drift, and the checks that matter here are cheap
 * and checkable by a human: did it answer at all, does the answer contain a number or
 * an explicit "no data", did it mention the branch the question named, was it quick.
 *
 * WHAT A RUN IS NOT. It is not a truth oracle: a wrong-but-confident number passes the
 * "grounded" check. It is a regression alarm — it catches "the model stopped using
 * tools", "every answer is an apology", "the date is wrong" — which is exactly the
 * class of failure that shipped to a customer.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { evalCase, evalResult, evalRun } from "./schema";

/** Questions worth asking every time a model or prompt changes. */
export const CANONICAL_CASES: { question: string; expectContains?: string }[] = [
  { question: "ภาพรวมวันนี้เป็นยังไง" },
  { question: "รอบซักเมื่อวานเท่าไหร่" },
  { question: "รายได้เดือนนี้เท่าไหร่" },
  { question: "เครื่องไหนไม่ได้ใช้งานนานแล้ว" },
  { question: "ช่วงเวลาไหนคนน้อยที่สุด" }
];

const MIN_ANSWER_LENGTH = 40;
const APOLOGY_MARKERS = ["ขออภัย", "เกิดข้อผิดพลาด", "ไม่สามารถประมวลผล"];
const NO_DATA_MARKERS = ["ไม่มีข้อมูล", "ยังไม่มีข้อมูล", "ไม่พบข้อมูล"];
const SLOW_MS = 30_000;

/**
 * Seed the set once: the canonical questions plus the questions real people asked.
 * A test suite that only contains questions someone invented tests the inventor.
 */
export function ensureEvalCases(): number {
  const existing = db.select().from(evalCase).all();
  if (existing.length > 0) return existing.length;

  const now = new Date();
  const rows = CANONICAL_CASES.map((item) => ({
    id: randomUUID(),
    question: item.question,
    expectContains: item.expectContains ?? null,
    origin: "canonical",
    createdAt: now
  }));
  db.insert(evalCase).values(rows).run();
  return rows.length;
}

export function listCases(): { id: string; question: string; expectContains: string | null; origin: string }[] {
  return db.select().from(evalCase).all().map((row) => ({
    id: row.id,
    question: row.question,
    expectContains: row.expectContains ?? null,
    origin: row.origin
  }));
}

export type EvalCheck = { name: string; passed: boolean; detail?: string };

export function scoreAnswer(input: {
  answer: string;
  expectContains?: string | null;
  latencyMs: number;
}): { score: number; checks: EvalCheck[] } {
  const text = input.answer.trim();
  const answered =
    text.length >= MIN_ANSWER_LENGTH && !APOLOGY_MARKERS.some((marker) => text.includes(marker));
  // "Has a number, or says outright that there is none" — the two honest answers.
  const grounded = /[0-9]/.test(text) || NO_DATA_MARKERS.some((marker) => text.includes(marker));
  const mentioned = input.expectContains ? text.includes(input.expectContains) : true;
  const timely = input.latencyMs < SLOW_MS;

  const checks: EvalCheck[] = [
    { name: "answered", passed: answered, detail: answered ? undefined : " apologized or too short" },
    { name: "grounded", passed: grounded },
    ...(input.expectContains ? [{ name: "mentions", passed: mentioned, detail: input.expectContains }] : []),
    { name: "timely", passed: timely, detail: `${input.latencyMs}ms` }
  ];
  const passed = checks.filter((check) => check.passed).length;
  return { score: Math.round((passed / checks.length) * 100), checks };
}

export type EvalAnswer = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  promptVersion: string;
};

export type EvalRunSummary = {
  runId: string;
  model: string;
  promptVersion: string;
  total: number;
  passed: number;
  averageScore: number;
  averageLatencyMs: number;
  results: { question: string; score: number; checks: EvalCheck[]; latencyMs: number }[];
};

/**
 * Replay the set. The caller supplies `answer` so this module never decides how to
 * talk to a model — production uses the same function the bot uses, which is the only
 * way a run says anything about production.
 */
export async function runEval(input: {
  answer: (question: string) => Promise<EvalAnswer>;
  limit?: number;
  baselineModel?: string | null;
}): Promise<EvalRunSummary> {
  ensureEvalCases();
  const cases = listCases().slice(0, input.limit ?? 5);
  const now = new Date();
  const runId = randomUUID();

  // The model is only known after the first answer; the row is written after the loop
  // so a run never claims a model it did not use.
  const results: (EvalResultRow & { latencyMs: number; question: string })[] = [];
  let model = "unknown";
  let promptVersion = "unknown";

  for (const testCase of cases) {
    const startedAt = Date.now();
    const answer = await input.answer(testCase.question);
    const latencyMs = Date.now() - startedAt;
    model = answer.model;
    promptVersion = answer.promptVersion;
    const scored = scoreAnswer({
      answer: answer.text,
      expectContains: testCase.expectContains,
      latencyMs
    });
    const row: EvalResultRow = {
      id: randomUUID(),
      runId,
      caseId: testCase.id,
      question: testCase.question,
      answer: answer.text.slice(0, 1200),
      score: scored.score,
      checks: JSON.stringify(scored.checks),
      latencyMs,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      createdAt: new Date()
    };
    db.insert(evalResult).values(row).run();
    results.push({ ...row, question: testCase.question });
  }

  db.insert(evalRun)
    .values({
      id: runId,
      model,
      promptVersion,
      baselineModel: input.baselineModel ?? null,
      status: "ok",
      startedAt: now,
      finishedAt: new Date()
    })
    .run();

  const total = results.length;
  return {
    runId,
    model,
    promptVersion,
    total,
    passed: results.filter((row) => row.score >= 75).length,
    averageScore: total === 0 ? 0 : Math.round(results.reduce((sum, row) => sum + row.score, 0) / total),
    averageLatencyMs: total === 0 ? 0 : Math.round(results.reduce((sum, row) => sum + row.latencyMs, 0) / total),
    results: results.map((row) => ({
      question: row.question,
      score: row.score,
      checks: JSON.parse(row.checks) as EvalCheck[],
      latencyMs: row.latencyMs
    }))
  };
}

type EvalResultRow = {
  id: string;
  runId: string;
  caseId: string;
  question: string;
  answer: string;
  score: number;
  checks: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
};

export type EvalRunView = {
  runId: string;
  model: string;
  promptVersion: string;
  baselineModel: string | null;
  startedAt: number;
  total: number;
  passed: number;
  averageScore: number;
  averageLatencyMs: number;
};

/** The last few runs, newest first — enough to see whether a change helped. */
export function listRuns(limit = 5): EvalRunView[] {
  // Insert order is the run order, and two runs can start in the same millisecond, so
  // "newest first" comes from reversing the rows rather than from sorting a timestamp.
  const runs = db.select().from(evalRun).all().sort((a, b) => Number(a.startedAt) - Number(b.startedAt)).slice(-limit).reverse();
  return runs.map((run) => {
    const results = db.select().from(evalResult).where(eq(evalResult.runId, run.id)).all();
    const total = results.length;
    return {
      runId: run.id,
      model: run.model,
      promptVersion: run.promptVersion,
      baselineModel: run.baselineModel ?? null,
      startedAt: Number(run.startedAt),
      total,
      passed: results.filter((row) => row.score >= 75).length,
      averageScore: total === 0 ? 0 : Math.round(results.reduce((sum, row) => sum + row.score, 0) / total),
      averageLatencyMs: total === 0 ? 0 : Math.round(results.reduce((sum, row) => sum + row.latencyMs, 0) / total)
    };
  });
}
