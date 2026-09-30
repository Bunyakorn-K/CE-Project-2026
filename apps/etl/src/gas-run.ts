#!/usr/bin/env node
// Home Assistant gas-pressure collector CLI — one pass: read the otterimju2
// manifold pressures over a lookback window and load them into
// fact_gas_pressure_sample. Idempotent, safe to run on a timer.
//
// Its own env file, like the weather collector: this reads HA + ClickHouse
// and never IRIS Postgres, so sharing the ETL env would hand it a
// PG_CONNECTION_STRING it cannot use.
//
// Config:
//   HA_BASE_URL        required, e.g. http://otterimju2.meepiangroup.com:8123
//   HA_TOKEN           required, a Home Assistant long-lived access token
//   GAS_TENANT_ID      required, UUID of the owning tenant
//   GAS_BRANCH_ID      required, UUID of the branch in dim_branch
//   GAS_BRANCH_SLUG    required, operator-facing site name, e.g. otterimju2
//   GAS_LOOKBACK_HOURS optional, default 3. Must stay under 7: Home
//                      Assistant's recorder purges at purge_keep_days = 7, so
//                      a longer outage is unrecoverable at the source, not
//                      here.
//   CLICKHOUSE_URL/USER/PASSWORD/DATABASE
//
// Exits non-zero on failure so a `restart: unless-stopped` container surfaces
// the error instead of silently idling.

import { ClickHouseClient } from "./clickhouse.js";
import { runGasCollector, GasCollectorError } from "./gas.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuidEnv(name: string): string {
  const value = requireEnv(name);
  if (!UUID_RE.test(value)) {
    // Worth failing loudly: a malformed UUID against a UUID column fails at
    // INSERT with a ClickHouse type error that does not name the env var.
    throw new Error(`${name} must be a UUID, got "${value}"`);
  }
  return value;
}

async function main(): Promise<void> {
  const lookbackRaw = process.env.GAS_LOOKBACK_HOURS;
  const lookbackHours = lookbackRaw ? Number(lookbackRaw) : 3;
  if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
    throw new Error(`GAS_LOOKBACK_HOURS must be a positive number, got "${lookbackRaw}"`);
  }
  if (lookbackHours > 7) {
    // Not fatal, but the ceiling is a source property, not a preference.
    console.warn(
      `WARNING: GAS_LOOKBACK_HOURS=${lookbackHours} exceeds Home Assistant's ` +
        `7-day recorder retention; older samples are already purged upstream.`
    );
  }

  const warehouse = new ClickHouseClient({
    url: process.env.CLICKHOUSE_URL,
    user: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
    database: process.env.CLICKHOUSE_DATABASE
  });

  const result = await runGasCollector({
    baseUrl: requireEnv("HA_BASE_URL"),
    token: requireEnv("HA_TOKEN"),
    target: {
      tenant_id: requireUuidEnv("GAS_TENANT_ID"),
      branch_id: requireUuidEnv("GAS_BRANCH_ID"),
      branch_slug: requireEnv("GAS_BRANCH_SLUG")
    },
    warehouse,
    lookbackHours
  });

  console.log(
    `Gas collection: ${result.inserted} rows over ${result.windowStart} .. ${result.windowEnd} ` +
      `(${result.unavailable} unavailable, kept as NULL)`
  );

  if (result.emptyChannels.length > 0) {
    // NOT a silent skip. An empty channel means the entity returned no states
    // in the window, which is either a quiet period or a renamed entity — and
    // those need different responses. Loud, but not a process failure: an
    // empty window during a shutdown is not an error.
    console.warn(
      `WARNING: no states returned for channel(s): ${result.emptyChannels.join(", ")}. ` +
        `An empty inner array from Home Assistant means no state changes in the ` +
        `window. If this persists across runs, verify the entity id in ` +
        `GAS_CHANNELS (apps/etl/src/gas.ts) still exists.`
    );
  }
}

main().catch((error) => {
  const message = error instanceof GasCollectorError ? error.message : String(error);
  console.error("Gas collection failed:", message);
  process.exit(1);
});
