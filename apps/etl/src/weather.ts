// TMD weather collector — fetches hourly forecasts from the Thai
// Meteorological Department NWP API and loads them into the analytics
// warehouse (fact_weather_sample). Idempotent: ReplacingMergeTree versioned
// by observation timestamp, converging to one row per (tenant, branch, ts).
//
// Since 2026-09-10 weather is collected PER REGISTERED BRANCH: the target
// list comes from dim_branch (active=1, province set), not from the
// TMD_PROVINCES env list. Each observation is tagged with tenant_id/branch_id
// so the F-12 correlation joins usage by branch instead of by a duplicated
// province label (TMD returned identical values for all provinces).
//
// Hard rules:
//   - The TMD API key comes from TMD_API_KEY env, never from source.
//   - Missing values stay NULL — we never fabricate a reading.

import type { ClickHouseClient } from "./clickhouse";
import { parseTmdTimestamp, toClickHouseUtc, nowUtc } from "./datetime";

export type TmdForecastPoint = {
  time: string;
  data: {
    tc?: number;
    rh?: number;
    rain?: number;
    cond?: number;
  };
};

export type TmdForecastResponse = {
  WeatherForecasts?: Array<{
    location?: { province?: string; lat?: number; lon?: number };
    forecasts?: TmdForecastPoint[];
  }>;
};

/** A registered branch that should have weather collected (from dim_branch). */
export type WeatherBranch = {
  tenant_id: string;
  branch_id: string;
  province: string;
};

export type WeatherRow = {
  timestamp: string;
  tenant_id: string;
  branch_id: string;
  province: string | null;
  weather_temp_c: number | null;
  weather_humidity_pct: number | null;
  weather_rain_mm: number | null;
  weather_cond: number | null;
};

/** Fetch the hourly forecast for one province from the TMD NWP API. */
export async function fetchTmdForecast(
  apiKey: string,
  province: string,
  fetchImpl: typeof fetch = fetch
): Promise<TmdForecastResponse> {
  const url = new URL("https://data.tmd.go.th/nwpapi/v1/forecast/location/hourly/place");
  url.searchParams.set("province", province);
  url.searchParams.set("fields", "tc,rh,rain,cond");
  url.searchParams.set("duration", "1");

  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`TMD API returned ${response.status} for province ${province}`);
  }
  return (await response.json()) as TmdForecastResponse;
}

/**
 * Load the collection targets: every branch that has a provisioned location
 * row in dim_branch_location (ops-written — the ETL transform only mirrors
 * IRIS dim_branch and must not guess a province) and is still active in
 * dim_branch. Branches without a location are skipped (no fabrication, no
 * geo inference).
 */
export async function loadWeatherBranches(warehouse: Pick<ClickHouseClient, "query">): Promise<WeatherBranch[]> {
  const rows = await warehouse.query<{ tenant_id: string; branch_id: string; province: string }>(
    `SELECT l.tenant_id, l.branch_id, l.province
     FROM dim_branch_location AS l FINAL
     INNER JOIN dim_branch AS b FINAL
       ON (l.tenant_id = b.tenant_id AND l.branch_id = b.branch_id)
     WHERE b.active = 1
     ORDER BY b.branch_name`
  );
  return rows.map((r) => ({
    tenant_id: String(r.tenant_id),
    branch_id: String(r.branch_id),
    province: r.province
  }));
}

/**
 * Normalize a TMD response into warehouse rows for one branch. Only the first
 * location's forecasts are used (the API is queried per province). Missing
 * numeric fields map to null — never fabricated.
 *
 * TIMEZONE: TMD timestamps carry a `+07:00` offset (Asia/Bangkok). We convert
 * them to a true UTC instant via date-fns-tz so the warehouse stores UTC
 * consistently with the rest of the pipeline (see ./datetime). The persisted
 * `timestamp` is a UTC `DateTime64(3)` literal, NOT local wall-clock.
 */
export function normalizeForecast(
  raw: TmdForecastResponse,
  branch: WeatherBranch,
  now: () => Date = nowUtc
): WeatherRow[] {
  const location = raw.WeatherForecasts?.[0];
  if (!location?.forecasts?.length) return [];

  const nowDate = now();
  const province = location.location?.province ?? branch.province;
  return location.forecasts.map((point) => {
    const tsUtc = parseTmdTimestamp(point.time, nowDate);
    return {
      timestamp: toClickHouseUtc(tsUtc),
      tenant_id: branch.tenant_id,
      branch_id: branch.branch_id,
      province,
      weather_temp_c: point.data?.tc ?? null,
      weather_humidity_pct: point.data?.rh ?? null,
      weather_rain_mm: point.data?.rain ?? null,
      weather_cond: point.data?.cond ?? null
    };
  });
}

/**
 * Run one collection pass: fetch every registered branch (dim_branch active +
 * province set) and insert rows keyed by (tenant_id, branch_id, timestamp).
 * Branches with no forecast rows are skipped silently.
 */
export async function runWeatherCollector(input: {
  apiKey: string;
  branches: WeatherBranch[];
  warehouse: Pick<ClickHouseClient, "insert">;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<{ fetched: number; rows: number; branches: string[] }> {
  const { apiKey, branches, warehouse } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  let rows = 0;

  for (const branch of branches) {
    const raw = await fetchTmdForecast(apiKey, branch.province, fetchImpl);
    const normalized = normalizeForecast(raw, branch, now);
    if (normalized.length > 0) {
      await warehouse.insert("fact_weather_sample", normalized);
      rows += normalized.length;
    }
  }
  return { fetched: branches.length, rows, branches: branches.map((b) => b.province) };
}