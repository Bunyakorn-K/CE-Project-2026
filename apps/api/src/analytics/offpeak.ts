// R09 (Phase 2) — off-peak window baseline. Ranks (hour-of-day, weekday)
// buckets by lowest paid-cycle usage over a date range. Buckets are
// Asia/Bangkok LOCAL hours (the caller's SQL already shifts UTC +7).
// Descriptive baseline only — never a forecast (R09 / algorithm-comparison.md
// §Baseline: percentile heuristic, min-cycles noise guard).

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export type OffPeakBucketRow = {
  rank: number;
  dayOfWeek: number;
  weekday: string;
  hourOfDay: number;
  branchId: string;
  branchName: string;
  cycles: number;
  totalDurationMin: number;
};

export type OffPeakRankingMeta = {
  method: "offpeak_percentile";
  rules: {
    minCycles: number;
    percentile: number;
    eligibleBuckets: number;
    returnedBuckets: number;
  };
};

export type OffPeakInput = Omit<OffPeakBucketRow, "rank" | "weekday">;

export function rankOffPeakBuckets(
  rows: OffPeakInput[],
  rules: { minCycles: number; percentile: number }
): { data: OffPeakBucketRow[]; meta: OffPeakRankingMeta } {
  const eligible = rows
    .filter((row) => row.cycles >= rules.minCycles)
    .sort((a, b) => a.cycles - b.cycles || a.totalDurationMin - b.totalDurationMin);

  // Bottom `percentile`% of eligible buckets, at least 1, capped at eligible.
  const take = Math.max(1, Math.ceil((eligible.length * rules.percentile) / 100));
  const data = eligible.slice(0, Math.min(take, eligible.length)).map((row, index) => ({
    ...row,
    rank: index + 1,
    weekday: WEEKDAY_LABELS[row.dayOfWeek - 1] ?? "?"
  }));

  return {
    data,
    meta: {
      method: "offpeak_percentile",
      rules: {
        minCycles: rules.minCycles,
        percentile: rules.percentile,
        eligibleBuckets: eligible.length,
        returnedBuckets: data.length
      }
    }
  };
}
