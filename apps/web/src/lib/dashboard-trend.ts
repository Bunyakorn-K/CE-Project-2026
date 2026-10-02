/**
 * The dashboard's daily trend chart.
 *
 * Pure, and separate from the route, for the same reason every other view
 * helper in this app is: the interesting decisions here are the ones that can
 * make the chart lie, and they have to be testable without a browser and
 * without a warehouse. The route holds the pixels; this holds the claims.
 *
 * The central one is the GAP. `dashboard.trend` carries only the days the
 * warehouse returned — AGENTS.md records the `2026-07-27` source gap as a real
 * discontinuity in the series, so a missing day is a day the warehouse cannot
 * speak about, NOT a day the branch did no business. Filling it with a zero
 * draws a dip to nothing on exactly the day that would most mislead an owner
 * reading a dip as bad news. So a gap breaks the line rather than joining it,
 * and it is labelled, because an unexplained break looks like a rendering bug.
 */

export type TrendPoint = {
  /** `YYYY-MM-DD`, the business day. */
  date: string;
  revenueSatang: number | null;
  cycles: number;
  usageRows: number;
};

/** One day of the drawn axis, whether or not the warehouse had a row for it. */
export type TrendDay = {
  date: string;
  /** `null` for a gap: no row for that day. Never `0`. */
  cycles: number | null;
  revenueSatang: number | null;
  usageRows: number;
  gap: boolean;
};

export const TREND_METRICS = {
  cycles: {
    label: "รอบซัก",
    axis: "รอบ",
    /** Raw units per display unit — 1 cycle is 1 cycle. */
    scale: 1,
    format: (value: number) => value.toLocaleString("th-TH")
  },
  revenue: {
    label: "รายได้",
    axis: "บาท",
    /** Satang per baht. Money stays in satang everywhere it is stored and summed,
     *  and is divided by this exactly once, at presentation. */
    scale: 100,
    format: (value: number) =>
      new Intl.NumberFormat("th-TH", { style: "currency", currency: "THB", maximumFractionDigits: 0 }).format(value / 100)
  }
} as const;

export type TrendMetricId = keyof typeof TREND_METRICS;

export const TREND_METRIC_LABELS: Record<TrendMetricId, string> = {
  cycles: "รอบซัก",
  revenue: "รายได้"
};

/**
 * The API's `trend` field. `null` is a source that cannot report one at all
 * (the IRIS/demo path), and it is a different state from `[]` — a source that
 * was asked and had nothing. They must not render the same, or "cannot say"
 * reads as "nothing happened".
 */
export type TrendInput = TrendPoint[] | null | undefined;

/**
 * Expands the returned days to a dense calendar across the selected window.
 *
 * Two things it deliberately does NOT do:
 *
 * - It does not interpolate across a gap. The gap day keeps `cycles: null`, and
 *   `trendSegments` breaks the line there, because a straight line through a
 *   day with no evidence asserts a number nobody measured.
 * - It does not clamp to the window's endpoints when the source disagrees. A
 *   day outside the requested range is dropped rather than drawn, because the
 *   range is what the reader was told they are looking at.
 *
 * A point whose date is not a real calendar day is dropped for the same reason
 * the API drops one: the axis is indexed by day, so a malformed one would put
 * the line somewhere the labels do not say.
 */
export function trendDays(input: TrendInput, from: string, to: string): TrendDay[] {
  const first = parseDay(from);
  const last = parseDay(to);
  // An unusable range yields no axis rather than a guessed one. The route only
  // queries a valid range, so this is a guard, not a state it renders.
  if (first === null || last === null || first > last) return [];

  const byDate = new Map<string, TrendPoint>();
  for (const point of input ?? []) {
    const day = parseDay(point?.date);
    if (day === null || day < first || day > last) continue;
    if (!Number.isFinite(point.cycles) || point.cycles < 0) continue;
    byDate.set(point.date, point);
  }

  const days: TrendDay[] = [];
  for (let cursor = first; cursor <= last; cursor += DAY_MS) {
    const date = isoDay(cursor);
    const point = byDate.get(date);
    days.push({
      date,
      cycles: point ? point.cycles : null,
      revenueSatang: point ? point.revenueSatang : null,
      usageRows: point?.usageRows ?? 0,
      gap: point === undefined
    });
  }
  return days;
}

const DAY_MS = 86_400_000;

function parseDay(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  // The round trip, not the shape test: `Date.parse("2026-02-31")` is a valid
  // timestamp because the engine rolls it into March, so a shape test alone
  // would let a day that never existed onto the axis.
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10) === value ? parsed : null;
}

function isoDay(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// What the card says
// ---------------------------------------------------------------------------

export const TREND_UNAVAILABLE_MESSAGE = "แนวโน้มรายวันไม่พร้อมใช้งาน · แหล่งข้อมูลนี้ไม่ได้รายงานยอดแยกตามวัน";
export const TREND_EMPTY_MESSAGE = "ไม่มีข้อมูลรายวันในช่วงเวลานี้";
export const TREND_GAP_NOTE = "เส้นที่ขาดหายไปคือวันที่ไม่มีแถว usage ที่รายงาน ไม่ใช่วันที่ไม่มีการใช้งาน";

export type TrendState =
  /** The source cannot report a per-day series. */
  | { kind: "unavailable"; message: string }
  /** The source was asked and has no days in this window. */
  | { kind: "empty"; message: string }
  /** Nothing at all in the window — the daily signal agrees with `usageRows`. */
  | { kind: "no-usage"; message: string }
  | { kind: "chart"; days: TrendDay[]; gapCount: number; note: string | null };

/**
 * Decides what the card renders, and what it says about itself.
 *
 * The four are distinct on purpose. `unavailable` is about the SOURCE and
 * `empty` is about the WINDOW, and collapsing them is how "we cannot measure
 * this" turns into "there was nothing here" — the exact fabrication this
 * repository keeps refusing.
 */
export function trendState(input: {
  trend: TrendInput;
  presence: "empty" | "present" | "unknown";
  from: string;
  to: string;
  emptyMessage?: string;
  unavailableMessage?: string;
}): TrendState {
  const unavailable = input.unavailableMessage ?? TREND_UNAVAILABLE_MESSAGE;
  const empty = input.emptyMessage ?? TREND_EMPTY_MESSAGE;

  if (input.trend === null || input.trend === undefined) {
    return { kind: "unavailable", message: unavailable };
  }
  if (input.presence === "empty") {
    return { kind: "no-usage", message: empty };
  }

  // An empty array is a MEASUREMENT — the warehouse was asked for days in this
  // window and returned none. It is not the same as `null`, which is a source
  // that cannot answer at all, and it must not render as a chart of nothing.
  if (input.trend.length === 0) return { kind: "empty", message: empty };

  const days = trendDays(input.trend, input.from, input.to);
  if (days.length === 0) return { kind: "empty", message: empty };

  const gapCount = days.filter((day) => day.gap).length;
  return {
    kind: "chart",
    days,
    gapCount,
    note: gapCount > 0 ? TREND_GAP_NOTE : null
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export type TrendMetric = (typeof TREND_METRICS)[TrendMetricId];

/** What the metric switch reads for one day. `null` is a gap or a withheld
 *  value, and both mean "draw nothing here" rather than "draw zero". */
export function metricValue(day: TrendDay, metric: TrendMetricId): number | null {
  if (metric === "cycles") return day.cycles;
  // Revenue is withheld by grant, not absent — a technician's chart shows the
  // cycle line and says the revenue series is unavailable, rather than a flat
  // zero line that would read as a business that took no money.
  return day.revenueSatang;
}

/**
 * Contiguous runs of days that HAVE a value for this metric.
 *
 * Each run becomes its own line path. A run of one is a single point, drawn as
 * a dot — a line needs two points, and inventing the second would fabricate a
 * trend on the day of a one-day window.
 */
export function trendSegments(days: TrendDay[], metric: TrendMetricId): TrendDay[][] {
  const segments: TrendDay[][] = [];
  let current: TrendDay[] = [];
  for (const day of days) {
    if (metricValue(day, metric) === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(day);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

export const CHART_WIDTH = 720;
export const CHART_HEIGHT = 220;
/** Room for the y-axis labels and the x-axis dates, so neither overlaps the plot. */
export const CHART_PADDING = { top: 16, right: 16, bottom: 34, left: 56 };

export type TrendGeometry = {
  segments: Array<{ points: Array<{ x: number; y: number; date: string }>; kind: "line" | "point" }>;
  /** Days with no value, drawn as a neutral tick on the baseline so a break in
   *  the line is visibly a break and not a rendering artifact. */
  gaps: Array<{ x: number; date: string }>;
  maxValue: number;
  /** Y-axis ticks, descending. EMPTY when the metric has no value on any day —
   *  an axis at zero would assert that the branch measured nothing. */
  ticks: number[];
  /** Whether any day carries a value for this metric at all. */
  hasValues: boolean;
  baselineY: number;
  plotWidth: number;
  /** Which days get an x-axis label, and the label itself. Keyed by `date`
   *  rather than by position so the component can anchor the first label to the
   *  left edge and the last to the right without re-deriving the index. */
  xLabels: Array<{ date: string; x: number; text: string }>;
};

/**
 * Maps the series onto the plot.
 *
 * The y-scale is anchored at zero and rounded up to a whole number, because a
 * truncated baseline is the classic way a chart exaggerates a change — a
 * one-day dip drawn from an auto-fitted axis can look like a collapse. A flat
 * all-zero series still gets a non-zero ceiling, so a single horizontal line at
 * the baseline is not mistaken for the top of the plot.
 *
 * A metric with NO value at all gets no axis rather than an axis at zero, and
 * those are different things. Measured zeros are a measurement — ฿0 a day means
 * the branch took nothing on days the warehouse reported. No values means the
 * metric was never measured: revenue withheld from a principal who may otherwise
 * see it, or a source that reports cycles without amounts. Printing a ฿0 scale
 * for that states a fact about the business that nobody established, and it was
 * found by a Playwright spec rather than by reading this code.
 */
export function trendGeometry(days: TrendDay[], metric: TrendMetricId): TrendGeometry {
  const values = days.map((day) => metricValue(day, metric)).filter((value): value is number => value !== null);
  const peak = values.length > 0 ? Math.max(...values) : 0;
  const scale = TREND_METRICS[metric].scale;
  // A step below one display unit would put fractional cycles on the axis, which
  // is a scale nobody measures in. Clamped, not rounded, so a peak of 1 still has
  // an axis above it.
  const tickStep = Math.max(scale, niceStep(peak / scale) * scale);
  const maxValue = peak <= 0 ? tickStep : Math.ceil(peak / tickStep) * tickStep;

  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const baselineY = CHART_PADDING.top + plotHeight;
  const step = days.length > 1 ? plotWidth / (days.length - 1) : 0;
  const xOf = (index: number) => CHART_PADDING.left + index * step;
  const yOf = (value: number) => baselineY - (value / maxValue) * plotHeight;

  const segments = trendSegments(days, metric).map((segment) => ({
    kind: segment.length === 1 ? ("point" as const) : ("line" as const),
    points: segment.map((day, position) => {
      const index = days.indexOf(day);
      return { x: xOf(index), y: yOf(metricValue(day, metric) ?? 0), date: day.date };
    })
  }));

  const gaps = days
    .map((day, index) => ({ day, index }))
    .filter(({ day }) => day.gap)
    .map(({ day, index }) => ({ x: xOf(index), date: day.date }));

  return {
    segments,
    gaps,
    maxValue,
    ticks: values.length > 0 ? axisTicks(maxValue, tickStep) : [],
    hasValues: values.length > 0,
    baselineY,
    plotWidth,
    xLabels: axisLabels(days, xOf)
  };
}

/**
 * The y-axis step, in DISPLAY units, rounded to a number a reader recognises.
 *
 * Fractions of the peak produce labels like 34 / 26 / 17 / 9, which are correct
 * arithmetic and useless as an axis: a reader cannot place a value between them,
 * and they read as measurement noise rather than as a scale. A step taken from
 * 1 / 2 / 2.5 / 5 × 10ⁿ puts the gridlines where the eye expects them and lets
 * the ceiling sit just above the peak instead of exactly on it.
 *
 * The step is chosen in the unit the axis LABEL uses, not in satang, or every
 * revenue step would be a multiple of 25 satang — ฿0.25, an amount nobody thinks
 * in. `metric.scale` is how many raw units one display unit is worth.
 */
function niceStep(peakInDisplayUnits: number): number {
  const rough = peakInDisplayUnits / 4;
  if (!(rough > 0)) return 1;
  // Snap to one significant figure rather than rounding UP to the next multiple
  // of the magnitude: at ฿1,062.50 a "first step at or above" rule jumps straight
  // to ฿2,000 and throws away a third of the plot, whereas 1,062.50's own
  // significant figure is 1 and ฿1,000 is the step a reader expects.
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / magnitude;
  const nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  return nice * magnitude;
}

/** Ticks from the ceiling down to zero in whole steps. */
function axisTicks(ceiling: number, step: number): number[] {
  const ticks: number[] = [];
  for (let value = ceiling; value > 0; value -= step) ticks.push(value);
  ticks.push(0);
  return ticks;
}

/**
 * Labels the first and last day, and nothing between them.
 *
 * A label per day on a 30-day window at 720px is ~24px of type per tick, which
 * overlaps in Thai. The endpoints are what a reader actually locates the window
 * by; the gaps between them are a shared scale, not a per-day reading, and the
 * hover/title on each point carries the exact day.
 */
function axisLabels(days: TrendDay[], xOf: (index: number) => number): Array<{ date: string; x: number; text: string }> {
  if (days.length === 0) return [];
  const first = { date: days[0].date, x: xOf(0), text: shortDay(days[0].date) };
  const last = days[days.length - 1];
  if (days.length === 1 || last.date === first.date) return [first];
  return [first, { date: last.date, x: xOf(days.length - 1), text: shortDay(last.date) }];
}

/** `2026-09-24` → `24 ก.ย.`. The year is dropped deliberately: every day on
 *  this axis is inside the one range stated in the evidence strip above the
 *  chart, and four Thai characters of year would crowd the label. */
export function shortDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString("th-TH", { day: "numeric", month: "short", timeZone: "UTC" });
}