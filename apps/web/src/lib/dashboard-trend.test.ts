import { describe, expect, it } from "vitest";
import {
  metricValue,
  shortDay,
  trendDays,
  trendGeometry,
  trendSegments,
  trendState,
  TREND_GAP_NOTE,
  TREND_METRICS,
  type TrendPoint
} from "./dashboard-trend";

const point = (date: string, cycles: number, revenueSatang: number | null = cycles * 100): TrendPoint => ({
  date,
  cycles,
  revenueSatang,
  usageRows: cycles
});

describe("the daily axis", () => {
  it("expands the returned days across the whole window", () => {
    const days = trendDays([point("2026-09-24", 10), point("2026-09-26", 30)], "2026-09-24", "2026-09-26");

    expect(days.map((day) => day.date)).toEqual(["2026-09-24", "2026-09-25", "2026-09-26"]);
    expect(days.map((day) => day.cycles)).toEqual([10, null, 30]);
  });

  // THE gap rule. AGENTS.md records 2026-07-27 as a genuine source gap, so a
  // zero here would draw a dip to nothing on the one day the warehouse cannot
  // speak about — which a reader sees as a bad day at the branch.
  it("leaves a day with no row a gap, never a zero", () => {
    const days = trendDays([point("2026-07-26", 10), point("2026-07-28", 12)], "2026-07-26", "2026-07-28");
    const gap = days[1];

    expect(gap.gap).toBe(true);
    expect(gap.cycles).toBeNull();
    // Not zero anywhere in the shape a caller might sum or scale.
    expect(gap.cycles).not.toBe(0);
  });

  it("keeps a day that has usage but no finished cycle", () => {
    const days = trendDays([{ date: "2026-07-26", cycles: 0, revenueSatang: 0, usageRows: 31 }], "2026-07-26", "2026-07-26");

    // Real usage evidence, zero cycles. Dropping it would repeat the "no rows"
    // claim for a day the warehouse did report on.
    expect(days[0].gap).toBe(false);
    expect(days[0].cycles).toBe(0);
    expect(days[0].usageRows).toBe(31);
  });

  // The range is what the reader was told they are looking at, so a day the
  // source volunteers outside it is dropped rather than drawn.
  it("drops days outside the requested window", () => {
    const days = trendDays([point("2026-09-01", 99), point("2026-09-24", 10), point("2026-10-01", 99)], "2026-09-24", "2026-09-26");

    expect(days.map((day) => day.date)).toEqual(["2026-09-24", "2026-09-25", "2026-09-26"]);
    expect(days.some((day) => day.cycles === 99)).toBe(false);
  });

  // `Date.parse("2026-02-31")` is a valid timestamp — the engine rolls it into
  // 2026-03-03 — so a shape test alone accepts a day that never existed.
  //
  // TWO things keep it off the axis, and this fixture is written to fail if
  // either is removed: the round-trip in `parseDay` rejects the day, and the
  // index is keyed by the RAW date string, so even a value that slipped past
  // would never match a real axis day. An earlier version of this test passed
  // against a shape-only implementation for the wrong reason — its malformed
  // date fell outside the window, so the RANGE filter dropped it and the
  // calendar check was never exercised. Hence the window deliberately spanning
  // the roll-over: 2026-03-03 is inside it and is a real day.
  it("drops a day that is not a real calendar date", () => {
    const days = trendDays([point("2026-02-28", 10), point("2026-02-31", 99)], "2026-02-28", "2026-03-03");

    expect(days.some((day) => day.cycles === 99)).toBe(false);
    // 03-03 is in the window and IS real, so the axis reaches it — proving the
    // 99 was dropped for being malformed rather than for being out of range.
    expect(days.map((day) => day.date)).toContain("2026-03-03");
    expect(days.map((day) => day.date)).not.toContain("2026-02-31");
  });

  it("drops a day whose cycle count is not a finite number", () => {
    const days = trendDays(
      [point("2026-09-24", 10), { date: "2026-09-25", cycles: Number.NaN, revenueSatang: null, usageRows: 0 }],
      "2026-09-24",
      "2026-09-26"
    );

    expect(days[1].gap).toBe(true);
  });

  it("carries an absent trend through as an all-gap axis rather than throwing", () => {
    expect(trendDays(undefined, "2026-09-24", "2026-09-26").every((day) => day.gap)).toBe(true);
  });

  it("produces no axis at all for a range that cannot be read", () => {
    expect(trendDays([point("2026-09-24", 10)], "not-a-date", "2026-09-26")).toEqual([]);
    expect(trendDays([point("2026-09-24", 10)], "2026-09-26", "2026-09-24")).toEqual([]);
  });
});

describe("what the card says", () => {
  const window = { from: "2026-09-24", to: "2026-09-26" };

  // Four states, and the pair that must never merge: a source that CANNOT
  // report a daily series, and a window that HAS none. "We cannot measure
  // this" reading as "there was nothing here" is the fabrication this whole
  // module exists to prevent.
  it("separates a source that cannot report a trend from a window with no days", () => {
    const unavailable = trendState({ trend: null, presence: "unknown", ...window });
    const empty = trendState({ trend: [], presence: "present", ...window });

    expect(unavailable.kind).toBe("unavailable");
    expect(empty.kind).toBe("empty");
    // Narrowed rather than asserted with a cast, so the test would fail to
    // COMPILE if either state grew a fourth shape.
    if (unavailable.kind !== "unavailable" || empty.kind !== "empty") return;
    expect(unavailable.message).not.toBe(empty.message);
  });

  it("does not treat an absent field as an empty series", () => {
    expect(trendState({ trend: undefined, presence: "present", ...window }).kind).toBe("unavailable");
  });

  it("reports no usage rather than a chart when the window has no usage rows", () => {
    const state = trendState({ trend: [point("2026-09-24", 0)], presence: "empty", ...window });

    // The daily signal and the presence signal agreeing on "nothing happened"
    // is the one case where a chart would be an empty box.
    expect(state.kind).toBe("no-usage");
  });

  it("charts the days it has and names the gaps", () => {
    const state = trendState({ trend: [point("2026-07-26", 10), point("2026-07-28", 12)], presence: "present", from: "2026-07-26", to: "2026-07-28" });

    expect(state.kind).toBe("chart");
    if (state.kind !== "chart") return;
    expect(state.gapCount).toBe(1);
    expect(state.note).toBe(TREND_GAP_NOTE);
  });

  // A chart with no note beside it would leave a reader guessing whether the
  // break in the line is missing data or a bug.
  it("says nothing about gaps when there are none", () => {
    const state = trendState({
      trend: [point("2026-09-24", 10), point("2026-09-25", 12), point("2026-09-26", 14)],
      presence: "present",
      ...window
    });

    expect(state.kind).toBe("chart");
    if (state.kind !== "chart") return;
    expect(state.gapCount).toBe(0);
    expect(state.note).toBeNull();
  });
});

describe("segments and the line", () => {
  it("breaks the line at a gap rather than joining across it", () => {
    const days = trendDays([point("2026-07-26", 10), point("2026-07-28", 12)], "2026-07-26", "2026-07-28");

    const segments = trendSegments(days, "cycles");

    // Two runs of one, not one run of three. A joined line would draw a rising
    // slope over a day with no evidence behind it.
    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.length)).toEqual([1, 1]);
  });

  it("keeps consecutive days in one segment", () => {
    const days = trendDays([point("2026-07-26", 10), point("2026-07-27", 12), point("2026-07-28", 14)], "2026-07-26", "2026-07-28");

    expect(trendSegments(days, "cycles")).toHaveLength(1);
    expect(trendSegments(days, "cycles")[0]).toHaveLength(3);
  });

  // A one-day window has one point, and a line needs two. Inventing the
  // second would draw a slope on a single measurement.
  it("marks a single-day segment as a point, not a line", () => {
    const days = trendDays([point("2026-09-24", 40)], "2026-09-24", "2026-09-24");

    expect(trendSegments(days, "cycles")).toHaveLength(1);
    expect(trendSegments(days, "cycles")[0]).toHaveLength(1);
    expect(trendGeometry(days, "cycles").segments[0].kind).toBe("point");
  });

  it("breaks the revenue line wherever revenue is withheld", () => {
    const days = trendDays(
      [
        { date: "2026-09-24", cycles: 10, revenueSatang: 1000, usageRows: 10 },
        { date: "2026-09-25", cycles: 12, revenueSatang: null, usageRows: 12 },
        { date: "2026-09-26", cycles: 14, revenueSatang: 1400, usageRows: 14 }
      ],
      "2026-09-24",
      "2026-09-26"
    );

    // The cycles are still there. A revenue withheld by grant is not a gap in
    // the DATA, so it must not remove the day from the chart — but it must not
    // be drawn as zero either.
    expect(trendSegments(days, "cycles")).toHaveLength(1);
    expect(trendSegments(days, "revenue")).toHaveLength(2);
    expect(metricValue(days[1], "revenue")).toBeNull();
    expect(metricValue(days[1], "cycles")).toBe(12);
  });

  it("never reads a gap or a withheld value as a number to scale", () => {
    const days = trendDays([point("2026-09-24", 10), point("2026-09-26", 30)], "2026-09-24", "2026-09-26");

    expect(metricValue(days[1], "cycles")).toBeNull();
  });
});

describe("geometry", () => {
  const days = trendDays(
    [point("2026-09-24", 10), point("2026-09-25", 40), point("2026-09-26", 30)],
    "2026-09-24",
    "2026-09-26"
  );

  // A truncated baseline is the classic way a chart exaggerates a change. The
  // peak sits at the top of the plot and zero at the bottom, so the drawn
  // height is the drawn proportion.
  it("anchors the scale at zero and rounds the ceiling up to a whole number", () => {
    const geometry = trendGeometry(days, "cycles");

    expect(geometry.maxValue).toBe(40);
    expect(geometry.ticks[geometry.ticks.length - 1]).toBe(0);
  });

  it("puts the peak at the top of the plot and zero at the baseline", () => {
    const geometry = trendGeometry(days, "cycles");
    const peak = geometry.segments[0].points[1];

    expect(peak.y).toBe(geometry.baselineY - (geometry.maxValue / geometry.maxValue) * (geometry.baselineY - 16));
  });

  it("raises the ceiling for an all-zero series so a flat line is not the plot's top edge", () => {
    const flat = trendDays([point("2026-09-24", 0), point("2026-09-25", 0)], "2026-09-24", "2026-09-25");

    expect(trendGeometry(flat, "cycles").maxValue).toBe(1);
    // Measured zeros are still measurements, so the axis stands.
    expect(trendGeometry(flat, "cycles").hasValues).toBe(true);
    expect(trendGeometry(flat, "cycles").ticks).not.toHaveLength(0);
  });

  // Found by a Playwright spec, not by reading the geometry: a revenue series
  // that is entirely null still rendered a ฿0 axis, which states that the
  // branch took no money on days nobody measured. Measured zero and unmeasured
  // are different facts and the axis is a claim either way.
  it("draws no axis at all for a metric with no value on any day", () => {
    const withheld = trendDays(
      [
        { date: "2026-09-24", cycles: 10, revenueSatang: null, usageRows: 10 },
        { date: "2026-09-25", cycles: 12, revenueSatang: null, usageRows: 12 }
      ],
      "2026-09-24",
      "2026-09-25"
    );

    const geometry = trendGeometry(withheld, "revenue");

    expect(geometry.hasValues).toBe(false);
    expect(geometry.ticks).toEqual([]);
    // The cycles on the same days are unaffected — one metric being unavailable
    // must not silence the other.
    expect(trendGeometry(withheld, "cycles").hasValues).toBe(true);
  });

  it("keeps the axis for an all-zero revenue series, which is a measurement", () => {
    const measuredZero = trendDays(
      [
        { date: "2026-09-24", cycles: 10, revenueSatang: 0, usageRows: 10 },
        { date: "2026-09-25", cycles: 12, revenueSatang: 0, usageRows: 12 }
      ],
      "2026-09-24",
      "2026-09-25"
    );

    expect(trendGeometry(measuredZero, "revenue").hasValues).toBe(true);
  });

  it("scales revenue in satang, not baht", () => {
    // ฿100.00 is 10,000 satang. Dividing by 100 before the ceiling is what
    // keeps the axis in the unit the axis label claims.
    const revenueDays = trendDays([point("2026-09-24", 1, 10000)], "2026-09-24", "2026-09-24");

    expect(trendGeometry(revenueDays, "revenue").maxValue).toBe(10000);
    expect(TREND_METRICS.revenue.format(10000)).toContain("100");
  });

  it("draws a gap as a neutral baseline tick so a break is visibly a break", () => {
    const withGap = trendDays([point("2026-07-26", 10), point("2026-07-28", 12)], "2026-07-26", "2026-07-28");

    expect(trendGeometry(withGap, "cycles").gaps.map((gap) => gap.date)).toEqual(["2026-07-27"]);
  });

  // One label per day on a 30-day window is ~24px of Thai type per tick, which
  // overlaps. The endpoints are what a reader locates the window by.
  // Fractions of the peak gave 34 / 26 / 17 / 9 — correct arithmetic, useless as
  // an axis: a reader cannot place a value between them. Found by looking at the
  // rendered chart, which no assertion covered.
  it("labels the y-axis in round steps rather than fractions of the peak", () => {
    const awkward = trendDays(
      [point("2026-09-24", 34), point("2026-09-25", 30), point("2026-09-26", 28)],
      "2026-09-24",
      "2026-09-26"
    );
    const ticks = trendGeometry(awkward, "cycles").ticks;

    expect(ticks).toEqual([40, 30, 20, 10, 0]);
    // The ceiling sits above the peak, so the highest point is inside the plot.
    expect(trendGeometry(awkward, "cycles").maxValue).toBeGreaterThan(34);
  });

  it("keeps a whole number of ticks whatever the peak", () => {
    for (const peak of [1, 3, 7, 34, 99, 640, 5050]) {
      const days = trendDays([point("2026-09-24", peak), point("2026-09-25", peak)], "2026-09-24", "2026-09-25");
      const geometry = trendGeometry(days, "cycles");

      expect(geometry.ticks.length).toBeGreaterThanOrEqual(2);
      expect(geometry.ticks[geometry.ticks.length - 1]).toBe(0);
      expect(geometry.maxValue).toBeGreaterThanOrEqual(peak);
      // A peak of exactly 1 cycle still needs room above it, or a single point
      // sits on the top edge of the plot.
      expect(geometry.maxValue).toBeGreaterThan(0);
      // Every tick a reader has to place a value between is a whole number.
      expect(geometry.ticks.every((tick) => Number.isInteger(tick))).toBe(true);
    }
  });

  // Revenue steps are chosen in BAHT, or every gridline would be a multiple of 25
  // satang and the axis would read ฿0, ฿37.50, ฿75 — amounts nobody thinks in.
  it("puts revenue steps on whole baht", () => {
    const days = trendDays([point("2026-09-24", 1, 425000), point("2026-09-25", 1, 410000)], "2026-09-24", "2026-09-25");
    const geometry = trendGeometry(days, "revenue");

    // ฿4,250 peak → a ฿1,000 step, ceiling ฿5,000.
    expect(geometry.maxValue).toBe(500000);
    expect(geometry.ticks).toEqual([500000, 400000, 300000, 200000, 100000, 0]);
    expect(geometry.ticks.map((tick) => TREND_METRICS.revenue.format(tick))).toEqual([
      "฿5,000",
      "฿4,000",
      "฿3,000",
      "฿2,000",
      "฿1,000",
      "฿0"
    ]);
  });

  it("labels the first and last day only", () => {
    expect(trendGeometry(days, "cycles").xLabels).toHaveLength(2);
    expect(trendGeometry(trendDays([point("2026-09-24", 5)], "2026-09-24", "2026-09-24"), "cycles").xLabels).toHaveLength(1);
  });

  it("spaces points across the plot in date order", () => {
    const geometry = trendGeometry(days, "cycles");
    const xs = geometry.segments[0].points.map((point) => point.x);

    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
  });
});

describe("axis labels", () => {
  it("renders a Thai short date without the year", () => {
    expect(shortDay("2026-09-24")).toContain("24");
    expect(shortDay("2026-09-24")).not.toContain("2026");
  });

  it("returns the input unchanged when it cannot be read", () => {
    expect(shortDay("nonsense")).toBe("nonsense");
  });
});