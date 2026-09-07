#!/usr/bin/env node
// TMD weather collector CLI — one pass: fetch hourly forecasts for the
// configured provinces and load them into the ClickHouse warehouse.
// Idempotent (ReplacingMergeTree keyed by province + timestamp), safe to
// run on a timer.
//
// Config: TMD_API_KEY (required), TMD_PROVINCES (comma list, default
// "เชียงใหม่"), CLICKHOUSE_URL/USER/PASSWORD/DATABASE.

import { resolve } from "node:path";
import { ClickHouseClient } from "./clickhouse.js";
import { parseProvinces, runWeatherCollector } from "./weather.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const apiKey = requireEnv("TMD_API_KEY");
  const provinces = parseProvinces(process.env.TMD_PROVINCES);
  const warehouse = new ClickHouseClient({
    url: process.env.CLICKHOUSE_URL,
    user: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
    database: process.env.CLICKHOUSE_DATABASE
  });
  const watermarkPath = resolve(process.env.ETL_WATERMARK_PATH ?? "./weather-watermark.json");
  void watermarkPath; // weather inserts are idempotent; no watermark needed

  const result = await runWeatherCollector({ apiKey, provinces, warehouse });
  console.log(`Weather collection complete: ${JSON.stringify(result)}`);
}

main().catch((error) => {
  console.error("Weather collection failed:", error);
  process.exit(1);
});
