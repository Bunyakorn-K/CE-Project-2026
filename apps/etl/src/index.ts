#!/usr/bin/env node
// LaundryTwin ETL CLI. Reads durable machine-usage data from the IRIS
// Postgres `iris_project` database and loads it into the LaundryTwin ClickHouse
// analytics warehouse (the tables queried by apps/api analytics).
//
// Config via env (see .env.example), loaded with `node --env-file=.env` (see
// the `start` script). The watermark lives at the path in ETL_WATERMARK_PATH
// and is advanced only after each committed batch.

import { resolve } from "node:path";
import { ClickHouseClient, CLICKHOUSE_REQUEST_BUDGET_DEFAULT_MS } from "./clickhouse.js";
import { createPostgresSource, POSTGRES_TIMEOUT_DEFAULTS } from "./postgres.js";
import { PHASE_BUDGET_DEFAULT_MS, runEtl, TEMPERATURE_LAG_DEFAULT_MS } from "./run.js";
import { WatermarkStore } from "./watermark.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got: ${raw}`);
  return parsed;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const connectionString = requireEnv("PG_CONNECTION_STRING");
  const warehouse = new ClickHouseClient({
    url: process.env.CLICKHOUSE_URL,
    user: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
    database: process.env.CLICKHOUSE_DATABASE,
    requestTimeoutMs: numEnv("ETL_CH_REQUEST_TIMEOUT_MS", CLICKHOUSE_REQUEST_BUDGET_DEFAULT_MS),
  });
  const watermarkPath = resolve(process.env.ETL_WATERMARK_PATH ?? "./etl-watermark.json");
  const watermarks = new WatermarkStore(watermarkPath);
  const source = createPostgresSource({
    connectionString,
    statementTimeoutMs: numEnv("ETL_PG_STATEMENT_TIMEOUT_MS", POSTGRES_TIMEOUT_DEFAULTS.statementTimeoutMs),
    connectTimeoutMs: numEnv("ETL_PG_CONNECT_TIMEOUT_MS", POSTGRES_TIMEOUT_DEFAULTS.connectTimeoutMs),
    idleTransactionTimeoutMs: numEnv(
      "ETL_PG_IDLE_IN_TX_TIMEOUT_MS",
      POSTGRES_TIMEOUT_DEFAULTS.idleTransactionTimeoutMs
    ),
  });

  const fallbackDays = Number(process.env.ETL_SINCE_FALLBACK_DAYS ?? "0");
  const lagHours = numEnv("ETL_TEMPERATURE_LAG_HOURS", TEMPERATURE_LAG_DEFAULT_MS / 3_600_000);

  // Announce the run before the first query: a phase that never returns must
  // still leave a line in `docker logs` naming where it stopped.
  console.log(
    `ETL run start at=${new Date(startedAt).toISOString()} ` +
      `usage_batch=${process.env.ETL_USAGE_BATCH ?? "2000"} ` +
      `temperature_batch=${process.env.ETL_TEMPERATURE_BATCH ?? "20000"} ` +
      `since_fallback_days=${fallbackDays} temperature_lag_hours=${lagHours}`
  );

  const result = await runEtl({
    source,
    warehouse,
    watermarks,
    sinceFallbackDays: fallbackDays,
    usageBatchSize: Number(process.env.ETL_USAGE_BATCH ?? "2000"),
    temperatureBatchSize: Number(process.env.ETL_TEMPERATURE_BATCH ?? "20000"),
    temperatureLagMs: lagHours * 3_600_000,
    phaseTimeoutMs: numEnv("ETL_PHASE_TIMEOUT_MS", PHASE_BUDGET_DEFAULT_MS),
    temperatureSinceIso: process.env.ETL_TEMPERATURE_SINCE_ISO ?? null,
  });

  await source.close();
  console.log(
    `ETL complete: ${result.branchesLoaded} branches, ${result.machinesLoaded} machines, ` +
      `${result.usagesLoaded} usages, ${result.temperaturesLoaded} temperature samples ` +
      `elapsed_ms=${Date.now() - startedAt}`
  );
}

main().catch((error) => {
  console.error("ETL failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
