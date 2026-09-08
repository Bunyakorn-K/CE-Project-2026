import type { ClickHouseExecutor } from "./clickhouse";
import { countSource, type QueryParams } from "./queries";

// F-12 (Phase 2) — weather demand correlation. Weather observations come from
// the TMD NWP API via the ETL collector (apps/etl/src/weather.ts) into
// fact_weather_sample. Correlation is descriptive only: R12 requires stating
// the source range and limits, never claiming causation or forecasting.
//
// TIMEZONE INVARIANT: both fact_weather_sample.timestamp and
// fact_machine_usage.started_at are stored as UTC. The join keys on the
// UTC hour, so no local-time shifting happens in SQL. (Older weather rows
// collected before the UTC fix carried Bangkok wall-clock; the collector
// rewrites those on re-insert because fact_weather_sample is ReplacingMergeTree.)
//
// Default branch filter is the Chiang Mai branch (about you.wash & dry แม่โจ้ -
// หลิ่งมื่น, branch_id 5e9611c1-6380-4d58-8ec7-ba4fb8fe4369) per the F-12
// scope decision to keep the first evaluation small. Pass branchId to override.

export const CHIANG_MAI_BRANCH_ID = "5e9611c1-6380-4d58-8ec7-ba4fb8fe4369";

export const WEATHER_USAGE_CORRELATION_SQL = `
SELECT
  toDate(w.timestamp) AS date,
  b.branch_name AS branchName,
  countIf(u.status IN ('finished', 'paid')) AS cycles,
  round(avg(w.weather_temp_c), 2) AS avgTempC,
  round(avg(w.weather_humidity_pct), 2) AS avgHumidityPct,
  round(sum(w.weather_rain_mm), 2) AS totalRainMm,
  countIf(w.weather_temp_c IS NULL) AS missingTemp,
  countIf(0) AS synthCount,
  count() AS totalCount
FROM fact_weather_sample AS w
LEFT JOIN fact_machine_usage AS u FINAL
  ON toStartOfHour(u.started_at) = toStartOfHour(w.timestamp)
  AND ({branchId:String} = '' OR toString(u.branch_id) = {branchId:String})
LEFT JOIN dim_branch AS b FINAL
  ON (u.tenant_id = b.tenant_id AND u.branch_id = b.branch_id)
WHERE w.timestamp >= {from:String} AND w.timestamp < plus(toDate({to:String}), 1)
  AND ({branchId:String} = '' OR toString(u.branch_id) = {branchId:String})
GROUP BY date, branchName
ORDER BY date, branchName`;

export type WeatherCorrelationRow = {
  date: string;
  branchName: string;
  cycles: number;
  avgTempC: number | null;
  avgHumidityPct: number | null;
  totalRainMm: number | null;
  missingTemp: number;
};

export async function queryWeatherUsageCorrelation(
  clickhouse: ClickHouseExecutor,
  params: QueryParams
): Promise<{ rows: WeatherCorrelationRow[] } & ReturnType<typeof countSource>> {
  const rows = await clickhouse<WeatherCorrelationRow & { synthCount: string; totalCount: string }>(
    WEATHER_USAGE_CORRELATION_SQL,
    params
  );
  return {
    rows: rows.map((row) => ({
      date: row.date,
      branchName: row.branchName,
      cycles: Number(row.cycles),
      avgTempC: row.avgTempC === null ? null : Number(row.avgTempC),
      avgHumidityPct: row.avgHumidityPct === null ? null : Number(row.avgHumidityPct),
      totalRainMm: row.totalRainMm === null ? null : Number(row.totalRainMm),
      missingTemp: Number(row.missingTemp)
    })),
    ...countSource(rows)
  };
}

/** Fixed caveat appended to every weather-correlation answer (R12). */
export const WEATHER_CAVEAT =
  "Correlation only: weather and usage are shown together for the requested period; " +
  "this does not establish causation and is not a forecast. Default scope: Chiang Mai branch.";
