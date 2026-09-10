#!/usr/bin/env node
// TMD weather collector CLI — one pass: fetch hourly forecasts for every
// REGISTERED branch (dim_branch active=1 with a province label) and load
// them into the ClickHouse warehouse. Idempotent (ReplacingMergeTree keyed
// by tenant_id + branch_id + timestamp), safe to run on a timer.
//
// Config: TMD_API_KEY (required), CLICKHOUSE_URL/USER/PASSWORD/DATABASE.
// TMD_PROVINCES is no longer used — the target list comes from dim_branch.

import { ClickHouseClient } from "./clickhouse.js";
import { loadWeatherBranches, runWeatherCollector } from "./weather.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const apiKey = requireEnv("TMD_API_KEY");
  const warehouse = new ClickHouseClient({
    url: process.env.CLICKHOUSE_URL,
    user: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
    database: process.env.CLICKHOUSE_DATABASE
  });

  const branches = await loadWeatherBranches(warehouse);
  if (branches.length === 0) {
    console.log("Weather collection skipped: no active branches with a province label in dim_branch");
    return;
  }

  const result = await runWeatherCollector({ apiKey, branches, warehouse });
  console.log(`Weather collection complete: ${JSON.stringify(result)}`);
}

main().catch((error) => {
  console.error("Weather collection failed:", error);
  process.exit(1);
});