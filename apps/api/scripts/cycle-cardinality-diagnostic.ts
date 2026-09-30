#!/usr/bin/env node
// Read-only diagnostic behind the canonical LaundryTwin cycle definition.
//
// Four surfaces rendered a number labelled "รอบ" (cycle) from
// `fact_machine_usage` and none of them agreed:
//
//   | Surface                    | Candidate expression                                      | Source |
//   |----------------------------|-----------------------------------------------------------|--------|
//   | /api/report/dashboard KPI  | uniqExactIf(machine_session_id, status IN (2,4)) per machine | apps/api/src/report/clickhouse-report.ts |
//   | dashboard twin tab         | countDistinct(machine_session_id), no status filter        | apps/api/src/report/clickhouse-report.ts |
//   | /api/v1/analytics/cycles/daily | countIf(status IN ('finished','paid'))                   | apps/api/src/analytics/queries.ts:31-33 |
//   | /api/v1/analytics/utilization | count(), no status filter                                | apps/api/src/analytics/queries.ts:112 |
//
// `CYCLE_DEFINITIONS` below is a FROZEN record of those four candidates, not a
// mirror of today's code. It was run against the real warehouse on 2026-09-29
// and the finding decided the question: one real session id is exactly one row
// with exactly one status, so the first two candidates were not a different
// measurement of a cycle — they were the same measurement minus the 63.91% of
// rows that carry no session id at all. The dashboard KPI and the twin tab now
// use the row-count definition; see
// docs/04_traceability/RTM_matrix.md ("Canonical cycle definition").
//
// The candidates are kept verbatim rather than updated, because the finding is
// the evidence: rewriting them to match today's code would delete the
// ฿125.42-per-"cycle" versus ฿42.20-per-row result that the decision rests on,
// and would make the script stop being able to reproduce it.
//
// A re-run today will NOT reproduce the ฿42.20. Measured 2026-09-30 11:39:11
// UTC, after the warehouse recovery merge: the same four expressions give
// ฿203.05, ฿127.08, ฿48.40, and ฿42.51 over 7,908 rows. The canonical row count
// is now ABOVE the plausible ฿40–45 band, so do not treat a ฿/cycle near ฿40–45
// as this script's pass condition — the ranking and the 1-row-per-session result
// are what reproduce. See docs/04_traceability/RTM_matrix.md
// ("Canonical cycle definition").
//
// `machine_session_id` still has no entry in
// docs/03_data_contracts/data_contracts.md, so the repo documents no meaning
// for it, and the seed script deliberately allows up to
// MAX_CYCLES_PER_SESSION = 3 rows per synthetic session
// (apps/api/scripts/seed-analytics.ts:58-59). Anything measured on seed data
// therefore answers a question about the seed, not about IRIS.
//
// This script is SELECT-only by construction: every statement is exported as a
// constant here and `cycle-cardinality-diagnostic.test.ts` asserts that none of
// them can write. It filters to non-synthetic rows
// (`NOT startsWith(source_event_id, 'synthetic:')`) and REFUSES to report a
// verdict when there are none, because a number computed from seed data would
// look like an answer and is not one.
//
// Run (config via env, see .env.example):
//   CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / CLICKHOUSE_DATABASE
// Optional flags: --from=YYYY-MM-DD --to=YYYY-MM-DD --branch=<uuid>
//   (all optional; omitting them measures the whole table)
//
// The connection for the production warehouse is NOT documented in this
// repository. See the "How to run against the production warehouse" section of
// docs/02_architecture/deploy-runbook.md for what is documented and what the
// operator must supply out of band.

import "../src/config";
import { createClickHouseClient, type ClickHouseExecutor } from "../src/analytics/clickhouse";

// ---------------------------------------------------------------------------
// Enum-version guard
// ---------------------------------------------------------------------------

/**
 * The numbering every candidate expression in this file is quoted against, and
 * the one `apps/api/scripts/migrate-usage-status-enum.ts` replaces.
 *
 * `status` is numbered by the IRIS lifecycle order. It was not, before that
 * migration: `admitted` sat at 6, after `cancelled`. This script's expressions
 * are frozen on purpose — they are the evidence the 2026-09-29 decision rests
 * on, and rewriting them to match today's code would delete the
 * ฿125.42-per-"cycle" versus ฿42.20-per-row result — but a frozen expression is
 * only readable while the enum still has the numbering it was frozen against.
 * After the migration, `status IN (2, 4)` names `paid` and `running`, not
 * `paid` and `finished`, and would report a confidently wrong number. So the
 * script probes the live enum and refuses rather than describe a warehouse it
 * is no longer reading correctly.
 */
export const PRE_MIGRATION_STATUS_TYPE =
  "Enum8('pending_payment' = 1, 'paid' = 2, 'running' = 3, 'finished' = 4, 'cancelled' = 5, 'admitted' = 6)";
export const POST_MIGRATION_STATUS_TYPE =
  "Enum8('pending_payment' = 1, 'paid' = 2, 'admitted' = 3, 'running' = 4, 'finished' = 5, 'cancelled' = 6)";

export type EnumVersion = "pre-migration" | "post-migration" | "unknown";

/** Compares the live column type against both known numberings, by name set AND
 *  by value — a type with the right names in the wrong order is the exact bug
 *  this guard exists to catch, so matching the name list alone would be useless. */
export function enumVersionOf(liveType: string): EnumVersion {
  if (liveType === PRE_MIGRATION_STATUS_TYPE) return "pre-migration";
  if (liveType === POST_MIGRATION_STATUS_TYPE) return "post-migration";
  return "unknown";
}

export const ENUM_VERSION_REFUSAL_REASON =
  "fact_machine_usage.status is not the pre-migration Enum8, so the candidate expressions quoted in this script " +
  "can no longer be read the way they were written. `status IN (2, 4)` meant paid + finished under the old " +
  "numbering; after the IRIS-lifecycle renumbering (admitted=3, running=4, finished=5, cancelled=6) the same " +
  "numbers name paid + running, and this script would report that as if it were revenue. The expressions are " +
  "deliberately not rewritten — they are the evidence the cycle decision rests on — so the script refuses instead. " +
  "On a migrated warehouse use the renumbered queries in apps/api/src/report/clickhouse-report.ts, which filter " +
  "by name. Refusing to measure.";

export function buildEnumTypeSQL(): string {
  return `
SELECT type
FROM system.columns
WHERE database = currentDatabase()
  AND table = 'fact_machine_usage'
  AND name = 'status'`;
}

// ---------------------------------------------------------------------------
// Shared SQL fragments
// ---------------------------------------------------------------------------

/**
 * Seed rows are marked in `source_event_id` (apps/api/scripts/seed-analytics.ts
 * keeps the `synthetic:` prefix there precisely so the warehouse can be
 * filtered back to real data). Everything below measures real rows only.
 */
export const REAL_ROW_PREDICATE = "NOT startsWith(source_event_id, 'synthetic:')";

const FROM_PARAM = "{from:String}";
const TO_PARAM = "{to:String}";
const BRANCH_PARAM = "{branchId:String}";

/**
 * Optional calendar range and branch scope, using the same empty-string-means-
 * "unfiltered" sentinel as apps/api/src/analytics/queries.ts.
 *
 * `started_at` is Nullable(DateTime64(3)) (apps/etl/src/schema.ts:76), so a
 * row with no start time is excluded from a bounded range by the NULL
 * comparison rather than by an invented default.
 */
function rangePredicate(alias?: string): string {
  const u = alias ? `${alias}.` : "";
  return [
    `(${FROM_PARAM} = '' OR ${u}started_at >= parseDateTime64BestEffortOrNull(${FROM_PARAM}, 3))`,
    `(${TO_PARAM} = '' OR ${u}started_at < plus(toDateOrNull(${TO_PARAM}), 1))`,
    `(${BRANCH_PARAM} = '' OR toString(${u}branch_id) = ${BRANCH_PARAM})`
  ].join("\n    AND ");
}

function whereRealRange(alias?: string): string {
  return `  WHERE ${alias ? `${REAL_ROW_PREDICATE.replace("source_event_id", `${alias}.source_event_id`)}` : REAL_ROW_PREDICATE}
    AND ${rangePredicate(alias)}`;
}

// ---------------------------------------------------------------------------
// The queries
// ---------------------------------------------------------------------------

/**
 * Q1 — is there anything real to measure at all? The verdict guard reads this
 * row. It counts the synthetic rows too, so the refusal can state how much of
 * the table it is declining to describe, and it is deliberately unfiltered by
 * range so a warehouse whose real rows sit outside the requested window is not
 * misreported as empty. Only the window columns apply the real-row predicate,
 * via `*If`, so no `WHERE` clause here can hide the synthetic rows.
 */
export function buildRowCountSQL(): string {
  return `
SELECT
  count() AS total_rows,
  countIf(startsWith(source_event_id, 'synthetic:')) AS synthetic_rows,
  countIf(${REAL_ROW_PREDICATE}) AS real_rows,
  minIf(started_at, ${REAL_ROW_PREDICATE}) AS first_real_row,
  maxIf(started_at, ${REAL_ROW_PREDICATE}) AS last_real_row
FROM fact_machine_usage FINAL`;
}

/** Q2 — rows per machine_session_id, as a distribution summary. */
export function buildSessionSpanSummarySQL(): string {
  return `
SELECT
  count() AS session_ids,
  min(rows_per_session) AS min_rows_per_session,
  max(rows_per_session) AS max_rows_per_session,
  round(avg(rows_per_session), 2) AS avg_rows_per_session,
  quantile(0.5)(rows_per_session) AS p50_rows_per_session,
  quantile(0.75)(rows_per_session) AS p75_rows_per_session,
  quantile(0.9)(rows_per_session) AS p90_rows_per_session,
  quantile(0.99)(rows_per_session) AS p99_rows_per_session
FROM (
  SELECT machine_session_id, count() AS rows_per_session
  FROM fact_machine_usage FINAL
${whereRealRange()}
    AND machine_session_id IS NOT NULL
  GROUP BY machine_session_id
)`;
}

/** Q3 — the histogram itself, one line per distinct row count. */
export function buildSessionSpanHistogramSQL(): string {
  return `
SELECT
  rows_per_session,
  count() AS session_ids
FROM (
  SELECT machine_session_id, count() AS rows_per_session
  FROM fact_machine_usage FINAL
${whereRealRange()}
    AND machine_session_id IS NOT NULL
  GROUP BY machine_session_id
)
GROUP BY rows_per_session
ORDER BY rows_per_session`;
}

/**
 * Q4 — can one session id carry more than one status?
 *
 * `multi_status_session_ids` answers that literally. `multi_revenue_status_session_ids`
 * is the narrower double-count condition for the dashboard KPI: a session whose
 * rows split across two members of `status IN (2, 4)` is counted once per
 * member because the KPI groups by status and takes
 * `uniqExactIf(machine_session_id, ...)` inside each group. A session mixing,
 * say, `finished` and `cancelled` does not inflate that KPI because only one of
 * the two members is inside the filter.
 */
export function buildMultiStatusSessionSQL(): string {
  return `
SELECT
  count() AS session_ids,
  countIf(distinct_statuses > 1) AS multi_status_session_ids,
  countIf(revenue_statuses > 1) AS multi_revenue_status_session_ids,
  max(distinct_statuses) AS max_distinct_statuses,
  max(revenue_statuses) AS max_revenue_statuses
FROM (
  SELECT
    machine_session_id,
    uniqExact(status) AS distinct_statuses,
    uniqExactIf(status, status IN (2, 4)) AS revenue_statuses
  FROM fact_machine_usage FINAL
${whereRealRange()}
    AND machine_session_id IS NOT NULL
  GROUP BY machine_session_id
)`;
}

/**
 * Q5 — a few session ids that really do span several rows or several statuses,
 * so the summary counts can be spot-checked by hand. Session ids are not a
 * secret; they are printed precisely so the measurement is auditable.
 */
export function buildMultiStatusSessionExamplesSQL(): string {
  return `
SELECT
  machine_session_id,
  toString(any(status)) AS any_status,
  toString(groupUniqArray(status)) AS statuses,
  count() AS rows,
  countIf(status IN (2, 4)) AS revenue_status_rows
FROM fact_machine_usage FINAL
${whereRealRange()}
  AND machine_session_id IS NOT NULL
GROUP BY machine_session_id
HAVING uniqExact(status) > 1 OR count() > 1
ORDER BY uniqExact(status) DESC, rows DESC, machine_session_id
LIMIT 10`;
}

/** Q6 — the real status distribution; does `paid` (2) or `running` (3) occur? */
export function buildStatusDistributionSQL(): string {
  return `
SELECT
  toString(status) AS status,
  count() AS rows,
  uniqExact(machine_session_id) AS distinct_session_ids
FROM fact_machine_usage FINAL
${whereRealRange()}
GROUP BY status
ORDER BY rows DESC, status`;
}

/**
 * Q7 — how often is machine_session_id absent? A high null rate makes every
 * session-distinct count under-report with no signal in the result, so it is
 * measured rather than assumed. `uniqExact` skips NULLs in ClickHouse, which is
 * why this is a separate COUNT.
 */
export function buildSessionNullRateSQL(): string {
  return `
SELECT
  count() AS rows,
  countIf(machine_session_id IS NULL) AS rows_without_session_id,
  round(100 * countIf(machine_session_id IS NULL) / count(), 2) AS null_session_pct,
  uniqExact(machine_session_id) AS distinct_session_ids
FROM fact_machine_usage FINAL
${whereRealRange()}`;
}

/** Q8 — the same null rate per branch; a bad source may fail on one branch only. */
export function buildBranchSessionNullRateSQL(): string {
  return `
SELECT
  toString(u.branch_id) AS branch_id,
  any(b.branch_name) AS branch_name,
  count() AS rows,
  countIf(u.machine_session_id IS NULL) AS rows_without_session_id,
  round(100 * countIf(u.machine_session_id IS NULL) / count(), 2) AS null_session_pct
FROM fact_machine_usage AS u FINAL
LEFT JOIN dim_branch AS b FINAL ON u.tenant_id = b.tenant_id AND u.branch_id = b.branch_id
${whereRealRange("u")}
GROUP BY branch_id
ORDER BY rows DESC, branch_id`;
}

/** Q9 — rows on 1-row sessions vs multi-row sessions, split by status. */
export function buildSessionSpanByStatusSQL(): string {
  return `
SELECT
  toString(u.status) AS status,
  multiIf(
    u.machine_session_id IS NULL, 'no_session_id',
    s.rows_per_session = 1, 'session_1_row',
    'session_multi_row'
  ) AS session_span,
  count() AS rows,
  uniqExact(u.machine_session_id) AS distinct_session_ids
FROM fact_machine_usage AS u FINAL
LEFT JOIN (
  SELECT machine_session_id, count() AS rows_per_session
  FROM fact_machine_usage FINAL
${whereRealRange()}
    AND machine_session_id IS NOT NULL
  GROUP BY machine_session_id
) AS s ON u.machine_session_id = s.machine_session_id
${whereRealRange("u")}
GROUP BY status, session_span
ORDER BY status, session_span`;
}

/**
 * Q10 — revenue divided by each of the four candidate cycle definitions,
 * recomputed on real rows instead of inferred from a price band.
 *
 * `dashboard_kpi_cycles` and `twin_tab_cycles` reproduce the grouping of their
 * own surfaces (per machine+status and per machine respectively) rather than a
 * flat distinct count, so a session spanning two machines or two statuses shows
 * up in the difference between them. `cycles_daily_rows` and
 * `utilization_rows` are flat row counts, which is what grouping cannot change.
 */
export function buildCycleDefinitionSQL(): string {
  return `
SELECT
  sumIf(amount_satang, status IN (2, 4)) AS revenue_satang,
  countIf(status IN (2, 4)) AS cycles_daily_rows,
  count() AS utilization_rows,
  uniqExactIf(machine_session_id, status IN (2, 4)) AS distinct_sessions_finished_or_paid,
  uniqExact(machine_session_id) AS distinct_sessions_any_status,
  (
    SELECT sum(cycles)
    FROM (
      SELECT machine_id, status, uniqExactIf(machine_session_id, status IN (2, 4)) AS cycles
      FROM fact_machine_usage FINAL
${whereRealRange()}
      GROUP BY machine_id, status
    )
  ) AS dashboard_kpi_cycles,
  (
    SELECT sum(sessions)
    FROM (
      SELECT machine_id, countDistinct(machine_session_id) AS sessions
      FROM fact_machine_usage FINAL
${whereRealRange()}
      GROUP BY machine_id
    )
  ) AS twin_tab_cycles
FROM fact_machine_usage FINAL
${whereRealRange()}`;
}

// ---------------------------------------------------------------------------
// The four candidate definitions, quoted from the code that renders them
// ---------------------------------------------------------------------------

export type CycleDefinition = {
  key: "dashboardKpi" | "twinTab" | "cyclesDaily" | "utilizationRows";
  surface: string;
  sql: string;
  source: string;
};

/**
 * A description of the disagreement as it stood on 2026-09-29, kept so the
 * finding stays reproducible. These entries are the candidate expressions that
 * were compared on the real warehouse, NOT the current code: the dashboard KPI
 * and the twin tab have since adopted the row-count definition, and this list
 * is deliberately not updated to match, because the gap between the session
 * count and the row count is the evidence the decision rests on.
 */
export const CYCLE_DEFINITIONS: CycleDefinition[] = [
  {
    key: "dashboardKpi",
    surface: "/api/report/dashboard KPI `cycles` (before 2026-09-29)",
    sql: "uniqExactIf(machine_session_id, status IN (2, 4)), grouped by machine, summed",
    source: "apps/api/src/report/clickhouse-report.ts"
  },
  {
    key: "twinTab",
    surface: "dashboard twin tab `cycleCount` (before 2026-09-29)",
    sql: "countDistinct(machine_session_id), no status filter, grouped by machine",
    source: "apps/api/src/report/clickhouse-report.ts"
  },
  {
    key: "cyclesDaily",
    surface: "/api/v1/analytics/cycles/daily `cycles`",
    sql: "countIf(status IN ('finished','paid')) — row count",
    source: "apps/api/src/analytics/queries.ts:31-33"
  },
  {
    key: "utilizationRows",
    surface: "/api/v1/analytics/utilization `cycles`",
    sql: "count() — row count, no status filter",
    source: "apps/api/src/analytics/queries.ts:112"
  }
];

// ---------------------------------------------------------------------------
// Pure measurement assembly
// ---------------------------------------------------------------------------

export type RowCounts = {
  totalRows: number;
  syntheticRows: number;
  realRows: number;
  firstRealRow: string | null;
  lastRealRow: string | null;
};

export type HistogramRow = { rowsPerSession: number; sessionIds: number };
export type SpanByStatusRow = { status: string; sessionSpan: string; rows: number; distinctSessionIds: number };
export type BranchNullRow = {
  branchId: string;
  branchName: string;
  rows: number;
  rowsWithoutSessionId: number;
  nullSessionPct: number | null;
};
export type CycleComparison = {
  revenueSatang: number;
  byDefinition: Array<CycleDefinition & { cycles: number; satangPerCycle: number | null; bahtPerCycle: number | null }>;
};

export type Measurements = {
  sessionSpan: {
    sessionIds: number;
    minRowsPerSession: number | null;
    maxRowsPerSession: number | null;
    avgRowsPerSession: number | null;
    p50: number | null;
    p75: number | null;
    p90: number | null;
    p99: number | null;
    multiRowSessionIds: number;
    histogram: HistogramRow[];
  };
  statusSpan: {
    sessionIds: number;
    multiStatusSessionIds: number;
    multiRevenueStatusSessionIds: number;
    maxDistinctStatuses: number | null;
    maxRevenueStatuses: number | null;
    examples: Array<{ machineSessionId: string; anyStatus: string; statuses: string; rows: number }>;
  };
  statusDistribution: Array<{ status: string; rows: number; distinctSessionIds: number }>;
  sessionIdCoverage: {
    rows: number;
    rowsWithoutSessionId: number;
    nullSessionPct: number | null;
    distinctSessionIds: number;
    perBranch: BranchNullRow[];
  };
  spanByStatus: SpanByStatusRow[];
  cycleComparison: CycleComparison;
};

export type DiagnosticRange = { from: string; to: string; branchId: string };

export type DiagnosticResult =
  | { refused: true; rowCounts: RowCounts; range: DiagnosticRange; reason: string }
  | { refused: false; rowCounts: RowCounts; range: DiagnosticRange; measurements: Measurements };
/**
 * The guard. Zero non-synthetic rows means every number this script could print
 * would describe seed data, so the script refuses instead of reporting.
 */
export function shouldRefuseVerdict(realRowCount: number): boolean {
  return !(realRowCount > 0);
}

export const REFUSAL_REASON =
  "fact_machine_usage holds no non-synthetic rows (every row's source_event_id starts with 'synthetic:'). " +
  "The only cycle numbers this warehouse can produce describe apps/api/scripts/seed-analytics.ts, not IRIS, " +
  "so they are not evidence about machine_session_id cardinality. Refusing to report a verdict. " +
  "Point CLICKHOUSE_URL/CLICKHOUSE_USER/CLICKHOUSE_PASSWORD/CLICKHOUSE_DATABASE at the real warehouse.";

/** ClickHouse JSONEachRow renders numbers as strings and NaN aggregates as "nan". */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: unknown, fallback = 0): number {
  return num(value) ?? fallback;
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/** Satang per cycle, or null when the denominator is zero. */
export function satangPerCycle(revenueSatang: number, cycles: number): number | null {
  if (!(cycles > 0)) return null;
  return Math.round((revenueSatang / cycles) * 100) / 100;
}

export type DiagnosticOptions = {
  from?: string;
  to?: string;
  branchId?: string;
  /** Live `status` column type. Injected by tests; when omitted the enum guard
   *  probes system.columns itself, which is the only extra query it may issue. */
  statusType?: string;
};

function params(options: DiagnosticOptions) {
  return { from: options.from ?? "", to: options.to ?? "", branchId: options.branchId ?? "" };
}

/**
 * Runs the ten SELECTs in order. Two gates come first.
 *
 * The enum gate: every candidate expression below is quoted against the
 * pre-migration numbering, so on a warehouse that has been renumbered the
 * script would report `paid` + `running` where it means `paid` + `finished`.
 * It refuses, and the refusal costs a single probe — nothing is measured.
 *
 * The row-count gate: when there is no real data, no further query is issued at
 * all, so there is no chance of a seed-derived number reaching the report.
 */
export async function runCycleCardinalityDiagnostic(
  executor: ClickHouseExecutor,
  options: DiagnosticOptions = {}
): Promise<DiagnosticResult> {
  const range = params(options);
  const unmeasured: RowCounts = {
    totalRows: 0,
    syntheticRows: 0,
    realRows: 0,
    firstRealRow: null,
    lastRealRow: null
  };

  const statusType =
    options.statusType ?? str((await executor<Record<string, unknown>>(buildEnumTypeSQL()))[0]?.type);
  if (enumVersionOf(statusType) !== "pre-migration") {
    return { refused: true, rowCounts: unmeasured, range, reason: ENUM_VERSION_REFUSAL_REASON };
  }

  const counts = await executor<Record<string, unknown>>(buildRowCountSQL());
  const rowCounts: RowCounts = {
    totalRows: int(counts[0]?.total_rows),
    syntheticRows: int(counts[0]?.synthetic_rows),
    realRows: int(counts[0]?.real_rows),
    firstRealRow: counts[0]?.first_real_row ? str(counts[0].first_real_row) : null,
    lastRealRow: counts[0]?.last_real_row ? str(counts[0].last_real_row) : null
  };

  if (shouldRefuseVerdict(rowCounts.realRows)) {
    return { refused: true, rowCounts, range, reason: REFUSAL_REASON };
  }

  const [summary, histogram, multiStatus, examples, statusDist, nullRate, branchNullRate, spanByStatus, comparison] =
    await Promise.all([
      executor<Record<string, unknown>>(buildSessionSpanSummarySQL(), range),
      executor<Record<string, unknown>>(buildSessionSpanHistogramSQL(), range),
      executor<Record<string, unknown>>(buildMultiStatusSessionSQL(), range),
      executor<Record<string, unknown>>(buildMultiStatusSessionExamplesSQL(), range),
      executor<Record<string, unknown>>(buildStatusDistributionSQL(), range),
      executor<Record<string, unknown>>(buildSessionNullRateSQL(), range),
      executor<Record<string, unknown>>(buildBranchSessionNullRateSQL(), range),
      executor<Record<string, unknown>>(buildSessionSpanByStatusSQL(), range),
      executor<Record<string, unknown>>(buildCycleDefinitionSQL(), range)
    ]);

  const summaryRow = summary[0] ?? {};
  const histogramRows: HistogramRow[] = histogram.map((row) => ({
    rowsPerSession: int(row.rows_per_session),
    sessionIds: int(row.session_ids)
  }));
  const comparisonRow = comparison[0] ?? {};
  const revenueSatang = int(comparisonRow.revenue_satang);
  const candidateCycles: Record<CycleDefinition["key"], number> = {
    dashboardKpi: int(comparisonRow.dashboard_kpi_cycles),
    twinTab: int(comparisonRow.twin_tab_cycles),
    cyclesDaily: int(comparisonRow.cycles_daily_rows),
    utilizationRows: int(comparisonRow.utilization_rows)
  };

  return {
    refused: false,
    rowCounts,
    range,
    measurements: {
      sessionSpan: {
        sessionIds: int(summaryRow.session_ids),
        minRowsPerSession: num(summaryRow.min_rows_per_session),
        maxRowsPerSession: num(summaryRow.max_rows_per_session),
        avgRowsPerSession: num(summaryRow.avg_rows_per_session),
        p50: num(summaryRow.p50_rows_per_session),
        p75: num(summaryRow.p75_rows_per_session),
        p90: num(summaryRow.p90_rows_per_session),
        p99: num(summaryRow.p99_rows_per_session),
        multiRowSessionIds: histogramRows.filter((row) => row.rowsPerSession > 1).reduce((sum, row) => sum + row.sessionIds, 0),
        histogram: histogramRows
      },
      statusSpan: {
        sessionIds: int(multiStatus[0]?.session_ids),
        multiStatusSessionIds: int(multiStatus[0]?.multi_status_session_ids),
        multiRevenueStatusSessionIds: int(multiStatus[0]?.multi_revenue_status_session_ids),
        maxDistinctStatuses: num(multiStatus[0]?.max_distinct_statuses),
        maxRevenueStatuses: num(multiStatus[0]?.max_revenue_statuses),
        examples: examples.map((row) => ({
          machineSessionId: str(row.machine_session_id),
          anyStatus: str(row.any_status),
          statuses: str(row.statuses),
          rows: int(row.rows)
        }))
      },
      statusDistribution: statusDist.map((row) => ({
        status: str(row.status),
        rows: int(row.rows),
        distinctSessionIds: int(row.distinct_session_ids)
      })),
      sessionIdCoverage: {
        rows: int(nullRate[0]?.rows),
        rowsWithoutSessionId: int(nullRate[0]?.rows_without_session_id),
        nullSessionPct: num(nullRate[0]?.null_session_pct),
        distinctSessionIds: int(nullRate[0]?.distinct_session_ids),
        perBranch: branchNullRate.map((row) => ({
          branchId: str(row.branch_id),
          branchName: str(row.branch_name),
          rows: int(row.rows),
          rowsWithoutSessionId: int(row.rows_without_session_id),
          nullSessionPct: num(row.null_session_pct)
        }))
      },
      spanByStatus: spanByStatus.map((row) => ({
        status: str(row.status),
        sessionSpan: str(row.session_span),
        rows: int(row.rows),
        distinctSessionIds: int(row.distinct_session_ids)
      })),
      cycleComparison: {
        revenueSatang,
        byDefinition: CYCLE_DEFINITIONS.map((definition) => {
          const cycles = candidateCycles[definition.key];
          return {
            ...definition,
            cycles,
            satangPerCycle: satangPerCycle(revenueSatang, cycles),
            bahtPerCycle: satangPerCycle(revenueSatang, cycles) === null ? null : satangPerCycle(revenueSatang, cycles)! / 100
          };
        })
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pct(value: number | null): string {
  return value === null ? "n/a" : `${value}%`;
}

function rowsPerSession(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function baht(value: number | null): string {
  return value === null ? "n/a" : `฿${value.toFixed(2)}`;
}

export function formatDiagnostic(result: DiagnosticResult): string {
  const lines: string[] = [];
  lines.push("LaundryTwin cycle-cardinality diagnostic — READ ONLY, no data written");
  lines.push(`Range: from=${result.range.from || "(all)"} to=${result.range.to || "(all)"} branch=${result.range.branchId || "(all)"}`);
  lines.push("");

  if (result.refused) {
    // The enum gate refuses before measuring anything, so printing zeros as
    // "row counts" would claim an empty table rather than an unmeasured one.
    if (result.rowCounts.totalRows === 0 && result.rowCounts.syntheticRows === 0 && result.rowCounts.realRows === 0) {
      lines.push("VERDICT: REFUSED — no verdict produced.");
      lines.push(result.reason);
      lines.push("Row counts were NOT measured: the guard above fired before any counting query was issued.");
      return lines.join("\n");
    }
    lines.push("Row counts in fact_machine_usage (FINAL):");
    lines.push(`  total_rows=${result.rowCounts.totalRows}  synthetic_rows=${result.rowCounts.syntheticRows}  real_rows=${result.rowCounts.realRows}`);
    lines.push(
      `  real data window: ${result.rowCounts.firstRealRow ?? "n/a"} .. ${result.rowCounts.lastRealRow ?? "n/a"}`
    );
    lines.push("");
    lines.push("VERDICT: REFUSED — no verdict produced.");
    lines.push(result.reason);
    return lines.join("\n");
  }

  const m = result.measurements;
  lines.push("1. Rows per machine_session_id");
  lines.push(
    `   session_ids=${m.sessionSpan.sessionIds}  min=${rowsPerSession(m.sessionSpan.minRowsPerSession)}  max=${rowsPerSession(m.sessionSpan.maxRowsPerSession)}  avg=${rowsPerSession(m.sessionSpan.avgRowsPerSession)}`
  );
  lines.push(
    `   p50=${rowsPerSession(m.sessionSpan.p50)}  p75=${rowsPerSession(m.sessionSpan.p75)}  p90=${rowsPerSession(m.sessionSpan.p90)}  p99=${rowsPerSession(m.sessionSpan.p99)}`
  );
  lines.push(`   session_ids spanning more than one row: ${m.sessionSpan.multiRowSessionIds}`);
  lines.push("   histogram (rows_per_session -> session_ids):");
  if (m.sessionSpan.histogram.length === 0) lines.push("     (none — no non-synthetic row carries a machine_session_id)");
  for (const row of m.sessionSpan.histogram) {
    lines.push(`     ${row.rowsPerSession} -> ${row.sessionIds}`);
  }
  lines.push("");

  lines.push("2. Can one session id carry more than one status?");
  lines.push(
    `   session_ids=${m.statusSpan.sessionIds}  multi_status=${m.statusSpan.multiStatusSessionIds}  multi_revenue_status(2,4)=${m.statusSpan.multiRevenueStatusSessionIds}`
  );
  lines.push(
    `   max_distinct_statuses=${rowsPerSession(m.statusSpan.maxDistinctStatuses)}  max_revenue_statuses=${rowsPerSession(m.statusSpan.maxRevenueStatuses)}`
  );
  if (m.statusSpan.examples.length > 0) {
    lines.push("   examples (spot-check these by hand):");
    for (const example of m.statusSpan.examples) {
      lines.push(`     ${example.machineSessionId}  rows=${example.rows}  statuses=${example.statuses}`);
    }
  }
  lines.push("");

  lines.push("3. Real status distribution");
  if (m.statusDistribution.length === 0) lines.push("   (none)");
  for (const row of m.statusDistribution) {
    lines.push(`   ${row.status.padEnd(16)} rows=${String(row.rows).padStart(7)}  distinct_session_ids=${row.distinctSessionIds}`);
  }
  lines.push("");

  lines.push("4. machine_session_id null rate");
  lines.push(
    `   overall: ${m.sessionIdCoverage.rowsWithoutSessionId}/${m.sessionIdCoverage.rows} rows without a session id (${pct(m.sessionIdCoverage.nullSessionPct)})`
  );
  lines.push("   per branch:");
  if (m.sessionIdCoverage.perBranch.length === 0) lines.push("     (none)");
  for (const row of m.sessionIdCoverage.perBranch) {
    lines.push(
      `     ${row.branchId}  ${row.branchName.padEnd(24)} rows=${String(row.rows).padStart(7)}  without_session_id=${String(row.rowsWithoutSessionId).padStart(7)}  (${pct(row.nullSessionPct)})`
    );
  }
  lines.push("");

  lines.push("5. Rows on 1-row sessions vs multi-row sessions, by status");
  if (m.spanByStatus.length === 0) lines.push("   (none)");
  for (const row of m.spanByStatus) {
    lines.push(
      `   ${row.status.padEnd(16)} ${row.sessionSpan.padEnd(20)} rows=${String(row.rows).padStart(7)}  distinct_session_ids=${row.distinctSessionIds}`
    );
  }
  lines.push("");

  lines.push(`6. Revenue (status IN (2,4)) = ${m.cycleComparison.revenueSatang} satang, divided by each candidate definition`);
  for (const definition of m.cycleComparison.byDefinition) {
    lines.push(
      `   ${definition.surface}\n     ${definition.sql}\n     cycles=${definition.cycles}  ${baht(definition.bahtPerCycle)}/cycle  (${definition.source})`
    );
  }
  lines.push("");
  lines.push(
    "This script does not choose a canonical definition and no cycle-counting behaviour was changed."
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): DiagnosticOptions {
  const options: DiagnosticOptions = {};
  for (const arg of argv) {
    const [flag, value] = arg.split("=", 2);
    if (flag === "--from") options.from = value;
    if (flag === "--to") options.to = value;
    if (flag === "--branch") options.branchId = value;
  }
  return options;
}

const invokedDirectly = process.argv[1]?.endsWith("cycle-cardinality-diagnostic.ts");
if (invokedDirectly) {
  runCycleCardinalityDiagnostic(createClickHouseClient(), parseArgs(process.argv.slice(2)))
    .then((result) => {
      console.log(formatDiagnostic(result));
      if (result.refused) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
