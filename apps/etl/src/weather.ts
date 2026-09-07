// TMD weather collector — fetches hourly forecasts from the Thai
// Meteorological Department NWP API and loads them into the analytics
// warehouse (fact_weather_sample). Idempotent: ReplacingMergeTree versioned
// by observation timestamp, so re-running converges to one row per
// (province, timestamp).
//
// Ported from the user's Go PoC (tmd_api.go, Aug 2026) with two hard rules:
//   - The TMD API key comes from TMD_API_KEY env, never from source.
//   - Missing values stay NULL — we never fabricate a reading.
//
// Config: TMD_API_KEY (required), TMD_PROVINCES (comma-separated, default
// "เชียงใหม่"), CLICKHOUSE_* for the warehouse.

import type { ClickHouseClient } from "./clickhouse";

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

export type WeatherRow = {
  timestamp: string;
  province: string;
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
 * Normalize a TMD response into warehouse rows. Only the first location's
 * forecasts are used (the API is queried per province). Missing numeric
 * fields map to null — never fabricated.
 */
export function normalizeForecast(
  raw: TmdForecastResponse,
  province: string,
  now: () => Date = () => new Date()
): WeatherRow[] {
  const location = raw.WeatherForecasts?.[0];
  if (!location?.forecasts?.length) return [];

  const observedAt = now().toISOString().replace("Z", "");
  return location.forecasts.map((point) => {
    // TMD returns "2026-09-07T15:00:00+07:00" — strip the +07:00 suffix
    // so ClickHouse DateTime64(3) can parse it without a TZ database.
    const ts = (point.time ?? observedAt).replace(/[+-]\d{2}:\d{2}$/, "");
    return {
      timestamp: ts,
      province: location.location?.province ?? province,
      weather_temp_c: point.data?.tc ?? null,
      weather_humidity_pct: point.data?.rh ?? null,
      weather_rain_mm: point.data?.rain ?? null,
      weather_cond: point.data?.cond ?? null
    };
  });
}

/** Parse the TMD_PROVINCES env list ("เชียงใหม่,กรุงเทพฯ") into trimmed names. */
export function parseProvinces(raw: string | undefined, fallback = "เชียงใหม่"): string[] {
  const value = (raw ?? "").trim();
  if (!value) return [fallback];
  const names = value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return names.length > 0 ? names : [fallback];
}

/** Run one collection pass: fetch every configured province and insert rows. */
export async function runWeatherCollector(input: {
  apiKey: string;
  provinces: string[];
  warehouse: Pick<ClickHouseClient, "insert">;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<{ fetched: number; rows: number; provinces: string[] }> {
  const { apiKey, provinces, warehouse } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  let rows = 0;

  for (const province of provinces) {
    const raw = await fetchTmdForecast(apiKey, province, fetchImpl);
    const normalized = normalizeForecast(raw, province, now);
    if (normalized.length > 0) {
      await warehouse.insert("fact_weather_sample", normalized);
      rows += normalized.length;
    }
  }
  return { fetched: provinces.length, rows, provinces };
}
