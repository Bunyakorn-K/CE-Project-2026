/**
 * Deleting old rows, on a clock.
 *
 * Three of these tables grow with every message: the transcript, the spans, and the
 * results of a test run. None of them has a natural end, and a homelab disk that is
 * already 92% full does not need a log that only grows. The windows are the decision,
 * written down once:
 *
 *   chat_turn     30 days  — a month is long enough to answer "what did it say then"
 *   ai_trace       7 days  — spans are for this week's latency question, not history
 *   eval_result   90 days  — comparison needs a few months of runs, not a year
 *
 * Nothing here deletes audit rows: an audit trail that expires on a timer is not an
 * audit trail.
 */

import { lt } from "drizzle-orm";
import { db } from "./db";
import { aiTrace, chatTurn, evalResult } from "./schema";
import { purgeExpiredChatTurns } from "./bot/memory";

export const TRACE_RETENTION_DAYS = 7;
export const EVAL_RETENTION_DAYS = 90;

export type PurgeSummary = { turns: number; traces: number; evals: number };

export function purgeAll(now: Date = new Date()): PurgeSummary {
  const traceCutoff = new Date(now.getTime() - TRACE_RETENTION_DAYS * 86_400_000);
  const evalCutoff = new Date(now.getTime() - EVAL_RETENTION_DAYS * 86_400_000);

  const beforeTraces = db.select({ id: aiTrace.id }).from(aiTrace).all().length;
  db.delete(aiTrace).where(lt(aiTrace.createdAt, traceCutoff)).run();
  const afterTraces = db.select({ id: aiTrace.id }).from(aiTrace).all().length;

  const beforeEvals = db.select({ id: evalResult.id }).from(evalResult).all().length;
  db.delete(evalResult).where(lt(evalResult.createdAt, evalCutoff)).run();
  const afterEvals = db.select({ id: evalResult.id }).from(evalResult).all().length;

  return {
    turns: purgeExpiredChatTurns(now),
    traces: beforeTraces - afterTraces,
    evals: beforeEvals - afterEvals
  };
}

/**
 * Run the purge every `intervalMs`, first after one hour.
 *
 * `unref()` so a timer never keeps the process alive — the API's lifetime is decided by
 * the container, not by housekeeping.
 */
export function startRetentionLoop(intervalMs = 6 * 60 * 60 * 1000): () => void {
  const run = () => {
    try {
      const summary = purgeAll();
      if (summary.turns + summary.traces + summary.evals > 0) {
        console.log(
          `[retention] purged turns=${summary.turns} traces=${summary.traces} evals=${summary.evals}`
        );
      }
    } catch (error) {
      console.error(`[retention] purge failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
