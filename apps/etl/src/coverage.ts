// Source-vs-warehouse coverage audit.
//
// WHY THIS EXISTS. Every "the warehouse is missing data" claim in this
// repository has, until now, been answered by counting rows in ClickHouse and
// comparing the result to a calendar. That comparison cannot distinguish three
// completely different situations, and picking the wrong one is expensive:
//
//   1. The source HAS the rows and the ETL failed to load them.   -> a real bug
//   2. The source has rows for the day, but none of them carry the
//      business timestamp the timeline is keyed on.               -> NOT a bug
//   3. The source genuinely has nothing for that day.             -> a real gap
//
// Case 2 is not hypothetical here, and it is not a rare shape. `fact_machine_usage`
// is keyed on `started_at` — the business day the row is ABOUT — while the ETL
// cursor is keyed on `created_at` — when the row arrived. Measured against
// production on 2026-10-02, IRIS holds 424 usage rows dated before the
// warehouse's first business day, and **not one of them carries a `started_at`**:
// IRIS began populating that column on 2026-07-22 and every earlier row is a
// dispatch that never started a cycle. So a naive calendar diff reports 68
// "missing days" that no amount of reloading could ever fill, and a backfill
// built on that diff would insert hundreds of rows that cannot appear on the
// business timeline at all.
//
// So the audit answers one question per day — "could a reload put a row on this
// day?" — by asking the SOURCE, not by counting the destination. It never
// writes. It reports, and it classifies.

/** What a day can be, once the source has been consulted. */
export type DayVerdict =
  /** The warehouse has rows for this business day. */
  | "present"
  /**
   * Absent from the warehouse, but the source holds rows carrying the business
   * timestamp — so a reload could genuinely fill it. This is the only verdict
   * that means "data is missing and recoverable".
   */
  | "recoverable"
  /**
   * Absent from the warehouse and the source has rows for the day, but none of
   * them carry the business timestamp. Nothing can fill this day, and no ETL
   * fault exists. This is the verdict a calendar diff cannot produce.
   */
  | "no_business_timestamp"
  /** Absent from the warehouse and the source has no rows for the day either. */
  | "absent_from_source";

export type DayCoverage = {
  /** `YYYY-MM-DD`. */
  day: string;
  verdict: DayVerdict;
  /** Rows for this day in the warehouse. */
  warehouseRows: number;
  /** Rows for this day in the source, by created_at. */
  sourceRows: number;
  /** Of those source rows, how many carry the business timestamp. */
  sourceRowsWithBusinessTimestamp: number;
};

export type CoverageSummary = {
  /** Inclusive `YYYY-MM-DD` bounds the audit examined. */
  from: string;
  to: string;
  days: DayCoverage[];
  /** Only the days a reload could actually fill. */
  recoverable: string[];
  /**
   * Days with no business timestamp anywhere. Reported separately and never
   * counted as missing, because "the warehouse lost it" and "it was never a
   * business day" are different claims.
   */
  noBusinessTimestamp: string[];
  /** Days neither side has. The only true data loss. */
  absentFromSource: string[];
};

function toDayNumber(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`not a YYYY-MM-DD day: ${day}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromDayNumber(n: number): string {
  return new Date(n).toISOString().slice(0, 10);
}

export function eachDay(from: string, to: string): string[] {
  const start = toDayNumber(from);
  const end = toDayNumber(to);
  if (end < start) throw new Error(`to (${to}) precedes from (${from})`);
  const out: string[] = [];
  // Bounded by construction: the span is validated as ordered, and a caller
  // asking for a century of days gets a century of strings rather than an
  // infinite loop, because `n` increments by a whole day.
  for (let n = start; n <= end; n += 86_400_000) out.push(fromDayNumber(n));
  return out;
}

/**
 * Classify every day in `from .. to`.
 *
 * `warehouse` and `source` are keyed by business day and come from the two
 * sides independently. `sourceWithBusinessTimestamp` is the part of the source
 * that could actually land on the timeline — the whole point of the audit, and
 * the column a count-only comparison never had.
 */
export function classifyCoverage(input: {
  from: string;
  to: string;
  /** business day -> rows in the warehouse */
  warehouse: Record<string, number>;
  /** business day (by created_at) -> rows in the source */
  source: Record<string, number>;
  /** business day -> source rows that carry the business timestamp */
  sourceWithBusinessTimestamp: Record<string, number>;
}): CoverageSummary {
  const days = eachDay(input.from, input.to).map((day): DayCoverage => {
    const warehouseRows = input.warehouse[day] ?? 0;
    const sourceRows = input.source[day] ?? 0;
    const sourceRowsWithBusinessTimestamp = input.sourceWithBusinessTimestamp[day] ?? 0;

    // Present is decided by the warehouse only. A source row the warehouse has
    // not loaded yet is not a present day, and a warehouse row that exists is
    // present regardless of what the source says today — the source is mutable
    // and the warehouse is the record.
    let verdict: DayVerdict;
    if (warehouseRows > 0) verdict = "present";
    else if (sourceRowsWithBusinessTimestamp > 0) verdict = "recoverable";
    else if (sourceRows > 0) verdict = "no_business_timestamp";
    else verdict = "absent_from_source";

    return { day, verdict, warehouseRows, sourceRows, sourceRowsWithBusinessTimestamp };
  });

  return {
    from: input.from,
    to: input.to,
    days,
    recoverable: days.filter((d) => d.verdict === "recoverable").map((d) => d.day),
    noBusinessTimestamp: days.filter((d) => d.verdict === "no_business_timestamp").map((d) => d.day),
    absentFromSource: days.filter((d) => d.verdict === "absent_from_source").map((d) => d.day)
  };
}

/**
 * The one-line answer to "is data missing?".
 *
 * Only `recoverable.length` counts as missing. Everything else is either
 * present or was never a business day, and reporting them together is what
 * turns a source-schema change into "68 days of data loss" on a dashboard.
 */
export function summarise(summary: CoverageSummary): string {
  const present = summary.days.filter((d) => d.verdict === "present").length;
  const parts = [
    `${summary.from} .. ${summary.to}`,
    `${present}/${summary.days.length} days present`,
    `${summary.recoverable.length} recoverable`,
    `${summary.noBusinessTimestamp.length} without a business timestamp`,
    `${summary.absentFromSource.length} absent from source`
  ];
  return parts.join(" · ");
}

/**
 * Whether this audit found something a human must look at.
 *
 * Deliberately narrow. It does NOT fire on `no_business_timestamp` — that state
 * is a property of the source schema, it is stable, and alerting on it would
 * train everyone to ignore this. It fires only on a genuinely recoverable gap,
 * which is the one condition that means the ETL fell behind.
 */
export function needsAttention(summary: CoverageSummary): boolean {
  return summary.recoverable.length > 0;
}