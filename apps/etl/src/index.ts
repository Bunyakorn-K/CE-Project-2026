#!/usr/bin/env node
// LaundryTwin ETL CLI. Reads durable machine-usage data from the IRIS
// Postgres `iris_project` database and loads it into the LaundryTwin ClickHouse
// analytics warehouse (the tables queried by apps/api analytics).
//
// Config via env (see .env.example). The watermark lives at the path in
// ETL_WATERMARK_PATH and is advanced only after each committed batch.

// Config via env (see .env.example), loaded with `node --env-file=.env` (see
// the `start` script). The watermark lives at the path in ETL_WATERMARK_PATH
// and is advanced only after each committed batch.

import { resolve } from "node:path";
import { ClickHouseClient } from "./clickhouse.js";
import { createPostgresSource } from "./postgres.js";
import { runEtl } from "./run.js";
import { WatermarkStore } from "./watermark.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const connectionString = requireEnv("PG_CONNECTION_STRING");
  const warehouse = new ClickHouseClient({
    url: process.env.CLICKHOUSE_URL,
    user: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
    database: process.env.CLICKHOUSE_DATABASE,
  });
  const watermarkPath = resolve(process.env.ETL_WATERMARK_PATH ?? "./etl-watermark.json");
  const watermarks = new WatermarkStore(watermarkPath);
  const source = createPostgresSource({ connectionString });

  const fallbackDays = Number(process.env.ETL_SINCE_FALLBACK_DAYS ?? "0");

  const result = await runEtl({
    source,
    warehouse,
    watermarks,
    sinceFallbackDays: fallbackDays,
    usageBatchSize: Number(process.env.ETL_USAGE_BATCH ?? "2000"),
    temperatureBatchSize: Number(process.env.ETL_TEMPERATURE_BATCH ?? "20000"),
  });

  await source.close();
  console.log(
    `ETL complete: ${result.branchesLoaded} branches, ${result.machinesLoaded} machines, ` +
      `${result.usagesLoaded} usages, ${result.temperaturesLoaded} temperature samples`
  );
}

main().catch((error) => {
  console.error("ETL failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
