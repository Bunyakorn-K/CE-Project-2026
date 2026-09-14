import { describe, expect, it } from "vitest";
import { rankOffPeakBuckets, WEEKDAY_LABELS } from "./offpeak";

// Factory: rows as [dayOfWeek, hourOfDay, cycles, totalDurationMin]
const rows = (over: Array<[number, number, number, number]>) =>
  over.map(([dayOfWeek, hourOfDay, cycles, totalDurationMin]) => ({
    dayOfWeek,
    hourOfDay,
    branchId: "b1",
    branchName: "B1",
    cycles,
    totalDurationMin
  }));

describe("rankOffPeakBuckets", () => {
  it("filters buckets below minCycles before ranking", () => {
    const r = rankOffPeakBuckets(rows([[1, 0, 2, 60], [2, 1, 15, 300], [3, 2, 40, 800]]), { minCycles: 10, percentile: 50 });
    expect(r.data.map((b) => b.hourOfDay)).toEqual([1]); // bucket with 2 cycles dropped
    expect(r.meta.rules?.eligibleBuckets).toBe(2);
  });

  it("returns bottom percentile with rank 1 = least cycles", () => {
    const r = rankOffPeakBuckets(
      rows([[1, 0, 5, 100], [2, 1, 20, 400], [3, 2, 60, 1200], [4, 3, 90, 1800]]),
      { minCycles: 1, percentile: 50 }
    );
    expect(r.data.map((b) => b.rank)).toEqual([1, 2]);
    expect(r.data.map((b) => b.hourOfDay)).toEqual([0, 1]); // least cycles first
  });

  it("caps take at eligible length and returns empty data when none eligible", () => {
    expect(rankOffPeakBuckets(rows([[1, 0, 1, 10]]), { minCycles: 10, percentile: 25 }).data).toEqual([]);
    expect(rankOffPeakBuckets(rows([]), { minCycles: 1, percentile: 25 }).data).toEqual([]);
  });

  it("labels weekdays Mon..Sun indexed by dayOfWeek-1", () => {
    expect(WEEKDAY_LABELS[0]).toBe("Mon");
    expect(WEEKDAY_LABELS[6]).toBe("Sun");
  });

  it("produces the full rules meta for consumers", () => {
    const r = rankOffPeakBuckets(rows([[1, 0, 5, 100], [2, 1, 20, 400]]), { minCycles: 1, percentile: 25 });
    expect(r.meta.method).toBe("offpeak_percentile");
    expect(r.meta.rules).toEqual({ minCycles: 1, percentile: 25, eligibleBuckets: 2, returnedBuckets: 1 });
  });
});