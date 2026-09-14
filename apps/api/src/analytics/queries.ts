import type { ClickHouseExecutor } from "./clickhouse";
import { dataSourceFromCounts, type AnalyticsMeta } from "./envelope";

// Fixed SQL templates — all user input flows through {from:String}{to:String}{branchId:String}
// (and {machineId:String}) bind parameters; nothing is ever concatenated into the query text.
// Empty-string sentinels mean "unfiltered". These templates are the single source of truth
// for both the Hono analytics routes and the MCP data server.

export type QueryParams = { from: string; to: string; branchId: string };

export type SourceCount = { totalRows: number; syntheticRows: number };

export function countSource(rows: Array<{ synthCount: string; totalCount: string }>): SourceCount {
  return {
    totalRows: rows.reduce((sum, row) => sum + Number(row.totalCount), 0),
    syntheticRows: rows.reduce((sum, row) => sum + Number(row.synthCount), 0)
  };
}

export function dataSourceEnvelope(meta: AnalyticsMeta, counts: SourceCount): AnalyticsMeta {
  return { ...meta, dataSource: dataSourceFromCounts(counts.totalRows, counts.syntheticRows) };
}

// ---- Revenue / cycles (daily) ----

export const DAILY_SQL = `
SELECT
  toDate(started_at) AS date,
  u.branch_id AS branchId,
  b.branch_name AS branchName,
  sumIf(amount_satang, status IN ('finished','paid')) AS revenueSatang,
  countIf(status IN ('finished','paid')) AS cycles,
  avgIf(duration_min, status IN ('finished','paid')) AS avgDurationMin,
  countIf(source_event_id LIKE 'synthetic:%') AS synthCount,
  count() AS totalCount
FROM fact_machine_usage AS u FINAL
INNER JOIN dim_branch AS b FINAL ON (u.tenant_id = b.tenant_id AND u.branch_id = b.branch_id)
WHERE started_at >= {from:String} AND started_at < plus(toDate({to:String}), 1)
  AND ({branchId:String} = '' OR toString(u.branch_id) = {branchId:String})
GROUP BY date, branchId, branchName
ORDER BY date, branchName`;

export type DailyRow = {
  date: string;
  branchId: string;
  branchName: string;
  revenueSatang: string;
  cycles: string;
  avgDurationMin: string;
  synthCount: string;
  totalCount: string;
};

export type DailyRevenueRow = {
  date: string;
  branchId: string;
  branchName: string;
  revenueSatang: number;
  cycles: number;
};

export type DailyCyclesRow = {
  date: string;
  branchId: string;
  branchName: string;
  cycles: number;
  avgDurationMin: number;
};

export async function queryDailyRevenue(
  clickhouse: ClickHouseExecutor,
  params: QueryParams
): Promise<{ rows: DailyRevenueRow[] } & SourceCount> {
  const rows = await clickhouse<DailyRow>(DAILY_SQL, params);
  return {
    rows: rows.map((row) => ({
      date: row.date,
      branchId: row.branchId,
      branchName: row.branchName,
      revenueSatang: Number(row.revenueSatang),
      cycles: Number(row.cycles)
    })),
    ...countSource(rows)
  };
}

export async function queryDailyCycles(
  clickhouse: ClickHouseExecutor,
  params: QueryParams
): Promise<{ rows: DailyCyclesRow[] } & SourceCount> {
  const rows = await clickhouse<DailyRow>(DAILY_SQL, params);
  return {
    rows: rows.map((row) => ({
      date: row.date,
      branchId: row.branchId,
      branchName: row.branchName,
      cycles: Number(row.cycles),
      avgDurationMin: Number(row.avgDurationMin)
    })),
    ...countSource(rows)
  };
}

// ---- Utilization heatmap ----

export const HEATMAP_SQL = `
SELECT
  toStartOfHour(started_at) AS hourBucket,
  u.machine_id AS machineId,
  m.machine_code AS machineCode,
  sum(duration_min) AS totalDurationMin,
  count() AS cycles,
  countIf(source_event_id LIKE 'synthetic:%') AS synthCount,
  count() AS totalCount
FROM fact_machine_usage AS u FINAL
INNER JOIN dim_machine AS m FINAL ON (u.tenant_id = m.tenant_id AND u.machine_id = m.machine_id)
WHERE started_at >= {from:String} AND started_at < plus(toDate({to:String}), 1)
  AND ({branchId:String} = '' OR toString(u.branch_id) = {branchId:String})
GROUP BY hourBucket, machineId, machineCode
ORDER BY hourBucket, machineCode`;

export type HeatmapRow = {
  hourBucket: string;
  machineId: string;
  machineCode: string;
  totalDurationMin: string;
  cycles: string;
  synthCount: string;
  totalCount: string;
};

export type HeatmapResultRow = {
  hourBucket: string;
  machineId: string;
  machineCode: string;
  totalDurationMin: number;
  cycles: number;
};

export async function queryUtilizationHeatmap(
  clickhouse: ClickHouseExecutor,
  params: QueryParams
): Promise<{ rows: HeatmapResultRow[] } & SourceCount> {
  const rows = await clickhouse<HeatmapRow>(HEATMAP_SQL, params);
  return {
    // hourBucket is ClickHouse's toStartOfHour string — returned verbatim.
    rows: rows.map((row) => ({
      hourBucket: row.hourBucket,
      machineId: row.machineId,
      machineCode: row.machineCode,
      totalDurationMin: Number(row.totalDurationMin),
      cycles: Number(row.cycles)
    })),
    ...countSource(rows)
  };
}

// ---- Temperature curve ----

export type CurveParams = QueryParams & { machineId: string };

export const CURVE_SQL = `
SELECT
  occurred_at AS occurredAt,
  s.machine_id AS machineId,
  m.machine_code AS machineCode,
  temperature_f AS temperatureF,
  temperature_c AS temperatureC,
  phase,
  countIf(event_id LIKE 'synthetic:%') OVER () AS synthCount,
  count() OVER () AS totalCount
FROM fact_temperature_sample AS s
INNER JOIN dim_machine AS m FINAL ON (s.tenant_id = m.tenant_id AND s.machine_id = toString(m.machine_id))
WHERE occurred_at >= {from:String} AND occurred_at < plus(toDate({to:String}), 1)
  AND ({branchId:String} = '' OR toString(s.branch_id) = {branchId:String})
  AND ({machineId:String} = '' OR s.machine_id = {machineId:String})
ORDER BY occurred_at ASC
LIMIT 5000`;

export type CurveRow = {
  occurredAt: string;
  machineId: string;
  machineCode: string;
  temperatureF: string | null;
  temperatureC: string | null;
  phase: string;
  synthCount: string;
  totalCount: string;
};

export type CurveResultRow = {
  occurredAt: string;
  machineId: string;
  machineCode: string;
  temperatureF: number | null;
  temperatureC: number | null;
  phase: string;
};

function toNumberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

export async function queryTemperatureCurve(
  clickhouse: ClickHouseExecutor,
  params: CurveParams
): Promise<{ rows: CurveResultRow[] } & SourceCount> {
  const rows = await clickhouse<CurveRow>(CURVE_SQL, params);
  return {
    // Null temperatures pass through untouched — a missing reading is not zero.
    rows: rows.map((row) => ({
      occurredAt: row.occurredAt,
      machineId: row.machineId,
      machineCode: row.machineCode,
      temperatureF: toNumberOrNull(row.temperatureF),
      temperatureC: toNumberOrNull(row.temperatureC),
      phase: row.phase
    })),
    ...countSource(rows)
  };
}

// ---- Off-peak windows (R09, Phase 2 baseline) ----
// Buckets are Asia/Bangkok LOCAL hours: started_at is stored UTC and Thailand
// is fixed UTC+7 (no DST), so both hour and weekday come from the +7 shift —
// the day boundary is Thai midnight, not UTC.

export const OFFPEAK_SQL = `
SELECT
  toHour(addHours(started_at, 7)) AS hourOfDay,
  toDayOfWeek(addHours(started_at, 7)) AS dayOfWeek,
  u.branch_id AS branchId,
  b.branch_name AS branchName,
  countIf(status IN ('finished','paid')) AS cycles,
  sumIf(duration_min, status IN ('finished','paid')) AS totalDurationMin,
  countIf(source_event_id LIKE 'synthetic:%') AS synthCount,
  count() AS totalCount
FROM fact_machine_usage AS u FINAL
INNER JOIN dim_branch AS b FINAL ON (u.tenant_id = b.tenant_id AND u.branch_id = b.branch_id)
WHERE started_at >= {from:String} AND started_at < plus(toDate({to:String}), 1)
  AND ({branchId:String} = '' OR toString(u.branch_id) = {branchId:String})
GROUP BY hourOfDay, dayOfWeek, branchId, branchName
ORDER BY cycles ASC, totalDurationMin ASC, dayOfWeek, hourOfDay`;

export type OffPeakRow = {
  hourOfDay: string;
  dayOfWeek: string;
  branchId: string;
  branchName: string;
  cycles: string;
  totalDurationMin: string;
  synthCount: string;
  totalCount: string;
};

export type OffPeakResultRow = {
  hourOfDay: number;
  dayOfWeek: number;
  branchId: string;
  branchName: string;
  cycles: number;
  totalDurationMin: number;
};

export async function queryOffPeakWindows(
  clickhouse: ClickHouseExecutor,
  params: QueryParams
): Promise<{ rows: OffPeakResultRow[] } & SourceCount> {
  const rows = await clickhouse<OffPeakRow>(OFFPEAK_SQL, params);
  return {
    rows: rows.map((row) => ({
      hourOfDay: Number(row.hourOfDay),
      dayOfWeek: Number(row.dayOfWeek),
      branchId: row.branchId,
      branchName: row.branchName,
      cycles: Number(row.cycles),
      totalDurationMin: Number(row.totalDurationMin)
    })),
    ...countSource(rows)
  };
}

// ---- Branch reference (for assistant context, not a fact table) ----

export async function listBranchNames(
  clickhouse: ClickHouseExecutor
): Promise<Array<{ branchId: string; branchName: string }>> {
  const rows = await clickhouse<{ branchId: string; branchName: string }>(
    "SELECT branch_id AS branchId, branch_name AS branchName FROM dim_branch FINAL ORDER BY branchName"
  );
  return rows.map((row) => ({ branchId: row.branchId, branchName: row.branchName }));
}
