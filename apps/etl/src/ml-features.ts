/**
 * `fact_ml_features` — the training dataset the ML guide describes and nothing
 * had built (R09, phase C).
 *
 * SHAPE. One row per **(branch × machine × hour)**. The guide's §4.1 used to
 * declare one row per (branch, date); that cannot carry an hourly cycle series,
 * and an hourly column with daily rows would be a column that lies. The
 * granularity is stated in one place — `docs/06_ml/ml-training-data-guide.md`
 * §4.1 — and this module is the implementation it names.
 *
 * THE ONE RULE THAT MATTERS: **a missing hour is NULL, never 0.** Measured
 * 2026-11-09, the warehouse holds 110 distinct usage days over a 111-day span,
 * and `2026-07-27` is a genuine source gap. On a gap day nothing was reported,
 * which is not the same fact as "the machines did no cycles", and a training
 * series that fills it with 0 teaches a model a demand collapse that never
 * happened. So the row is emitted (the spine is machines × hours, not
 * observation), and its `cycle_count` is NULL when the *day* reported no usage
 * rows at all. Inside a day that reported rows, an empty hour really is 0.
 *
 * WHY A SPINE AND NOT A GROUP BY. Grouping usage rows can only produce hours
 * that had rows, which is exactly the shape that silently drops the gap. The
 * spine is generated from `numbers()` and LEFT JOINed, so every hour exists and
 * every absence is explicit.
 *
 * NOTHING HERE IS SCHEDULED. There is no DAG and no timer: the print-it-yourself
 * command in `apps/etl/src/ml-features-run.ts` is the reproducibility guarantee,
 * and a scheduled writer would need its own statement about freshness.
 */

import type { ClickHouseClient } from "./clickhouse";
import { ML_FEATURES_DDL, ML_FEATURES_TABLE } from "./schema";

/**
 * The DDL lives in `schema.ts` beside every other table so the ETL's DDL pass
 * creates it; this module is the builder that fills it.
 */
export { ML_FEATURES_TABLE };


export type MlFeaturesWindow = { from: string; to: string };

/**
 * The INSERT ... SELECT that fills the window.
 *
 * `from`/`to` are `YYYY-MM-DD HH:MM:SS` UTC strings, half-open (`>= from`,
 * `< to`). `started_at` is `Nullable(DateTime64(3))` and 631 rows carry no
 * value (measured 2026-11-09), so they cannot be placed in an hour and are
 * excluded here — `buildMlFeatures` reports how many, because a silently
 * dropped row is the failure mode this repository keeps paying for.
 */
export function buildMlFeaturesInsertSQL(): string {
  return `INSERT INTO ${ML_FEATURES_TABLE}
WITH
    day_coverage AS (
        SELECT tenant_id, branch_id, toDate(started_at) AS day, count() AS rows
        FROM fact_machine_usage FINAL
        WHERE started_at IS NOT NULL
          AND started_at >= {from:DateTime} AND started_at < {to:DateTime}
        GROUP BY tenant_id, branch_id, day
    ),
    usage_hourly AS (
        SELECT
            tenant_id,
            branch_id,
            machine_id,
            toStartOfHour(started_at) AS hour,
            count() AS cycles,
            countIf(status = 'paid') AS paid,
            countIf(status = 'finished') AS finished,
            countIf(status = 'cancelled') AS cancelled,
            sum(duration_min) AS duration_min,
            sum(amount_satang) AS revenue_satang
        FROM fact_machine_usage FINAL
        WHERE started_at IS NOT NULL
          AND started_at >= {from:DateTime} AND started_at < {to:DateTime}
        GROUP BY tenant_id, branch_id, machine_id, hour
    ),
    weather_day AS (
        SELECT
            tenant_id,
            branch_id,
            toDate(timestamp) AS day,
            avg(weather_temp_c) AS avg_temperature_c,
            sum(weather_rain_mm) AS total_rain_mm
        FROM fact_weather_sample
        WHERE timestamp >= {from:DateTime} AND timestamp < {to:DateTime}
        GROUP BY tenant_id, branch_id, day
    )
SELECT
    d.tenant_id,
    d.branch_id,
    d.machine_id,
    toString(d.machine_kind) AS machine_kind,
    h.hour,
    toDate(h.hour) AS day,
    toHour(h.hour) AS hour_of_day,
    toDayOfWeek(h.hour) % 7 AS day_of_week,
    if(toDayOfWeek(h.hour) IN (6, 7), 1, 0) AS is_weekend,
    toMonth(h.hour) AS month,
    if(coverage.rows = 0, NULL, coalesce(u.cycles, 0)) AS cycle_count,
    if(coverage.rows = 0, NULL, coalesce(u.paid, 0)) AS paid_count,
    if(coverage.rows = 0, NULL, coalesce(u.finished, 0)) AS finished_count,
    if(coverage.rows = 0, NULL, coalesce(u.cancelled, 0)) AS cancelled_count,
    if(coverage.rows = 0, NULL, toFloat64(coalesce(u.duration_min, 0))) AS total_duration_min,
    if(coverage.rows = 0, NULL, coalesce(u.revenue_satang, 0)) AS revenue_satang,
    w.avg_temperature_c,
    w.total_rain_mm,
    now() AS built_at
FROM (
    SELECT DISTINCT tenant_id, branch_id, machine_id, machine_kind
    FROM dim_machine FINAL
    WHERE active = 1
) AS d
CROSS JOIN (
    SELECT toStartOfHour(toDateTime({from:DateTime}) + toIntervalHour(number)) AS hour
    FROM numbers(dateDiff('hour', {from:DateTime}, {to:DateTime}))
) AS h
LEFT JOIN usage_hourly AS u
    ON u.tenant_id = d.tenant_id AND u.branch_id = d.branch_id
   AND u.machine_id = d.machine_id AND u.hour = h.hour
LEFT JOIN day_coverage AS coverage
    ON coverage.tenant_id = d.tenant_id AND coverage.branch_id = d.branch_id
   AND coverage.day = toDate(h.hour)
LEFT JOIN weather_day AS w
    ON w.tenant_id = d.tenant_id AND w.branch_id = d.branch_id
   AND w.day = toDate(h.hour)`;
}

export type MlFeaturesReport = {
  window: MlFeaturesWindow;
  totalRows: number;
  distinctDays: number;
  distinctMachines: number;
  rowsWithNullCycles: number;
  usageRowsWithoutStartedAt: number;
};

/**
 * Create (if absent), fill, and count.
 *
 * The counts are printed by the caller, not returned as prose: a dataset that
 * cannot state its own size is one that has to be trusted.
 */
export async function buildMlFeatures(
  client: ClickHouseClient,
  window: MlFeaturesWindow
): Promise<MlFeaturesReport> {
  await client.query(ML_FEATURES_DDL);
  await client.query(buildMlFeaturesInsertSQL(), {
    // This client's second argument is the ClickHouse URL-parameter channel, so a
    // named `{from:DateTime}` placeholder must arrive as `param_from`.
    param_from: window.from,
    param_to: window.to
  });

  const [totals] = await client.query<{
    total_rows: string;
    days: string;
    machines: string;
    null_cycles: string;
  }>(
    `SELECT count() AS total_rows,
            uniqExact(day) AS days,
            uniqExact(machine_id) AS machines,
            countIf(cycle_count IS NULL) AS null_cycles
     FROM ${ML_FEATURES_TABLE} FINAL
     WHERE hour >= {from:DateTime} AND hour < {to:DateTime}`,
    { param_from: window.from, param_to: window.to }
  );

  const [orphans] = await client.query<{ orphans: string }>(
    `SELECT count() AS orphans FROM fact_machine_usage FINAL
     WHERE started_at IS NULL
       AND extracted_at >= {from:DateTime} AND extracted_at < {to:DateTime}`,
    { param_from: window.from, param_to: window.to }
  );

  return {
    window,
    totalRows: Number(totals?.total_rows ?? 0),
    distinctDays: Number(totals?.days ?? 0),
    distinctMachines: Number(totals?.machines ?? 0),
    rowsWithNullCycles: Number(totals?.null_cycles ?? 0),
    usageRowsWithoutStartedAt: Number(orphans?.orphans ?? 0)
  };
}
