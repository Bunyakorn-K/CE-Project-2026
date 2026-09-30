// ClickHouse target schema — mirrored from the LIVE warehouse
// (`laundrytwin_analytics` on VM 117). These tables already exist with this
// exact DDL; this module is the source of truth the ETL INSERTs against and,
// for a fresh environment, what it would create. We deliberately do NOT emit a
// `CREATE TABLE IF NOT EXISTS` at runtime that could diverge from a live table;
// the ETL assumes the schema below (and validated extra enum members) is present.
//
// Idempotency: fact_machine_usage is ReplacingMergeTree versioned by the source
// row's own updated_at, so a re-insert converges to one row.
// fact_temperature_sample is a plain MergeTree, so re-inserting a temperature
// row leaves a second copy — the ETL watermark must never re-read a window it
// has already loaded. Money stays integer satang; temperature_f is the raw
// integer from the source and temperature_c the derived Celsius. Missing data
// stays NULL — we never fabricate a value.
//
// Enum members (validated live / aligned with IRIS source):
//   status         pending_payment, paid, admitted, running, finished, cancelled
//   initiated_via  staff_v3, liff, kiosk_k2, coin
//   temp_level     cold, warm, hot, low, medium, high
//   machine_kind   washer, dryer
//   attribution_source  staff_v3, liff, handheld_dispatch, unknown
//
// `status` above is NUMBERED BY THE IRIS LIFECYCLE ORDER, deliberately, and
// that is the one enum in this file whose integers are not incidental:
//
//   pending_payment -> paid -> admitted -> running -> finished
//                                           + cancelled
//
// The order is read off the upstream source (Meepain-group/iris-project @
// 813ffa7), not inferred: migration 0053:28-30 constrains the lifecycle
// projector to desired_status IN ('running','finished'); active-machine-usage.ts
// :22-33 counts paid/running as in-progress and admitted/pending_payment as
// occupancy-only; cron.ts:2202 sweeps pending_payment -> cancelled; and
// 0053:41-44 makes last_phase = 'IDLE' a hard CHECK for finished. `cancelled`
// is a terminal branch off the same point as `finished`, not a step after it.
//
// This declaration previously had `admitted = 6`, which put the first step of a
// running cycle after `cancelled` and made `status >= 3` wrong. It is corrected
// here, but note what this file can and cannot do about it: `CREATE TABLE IF
// NOT EXISTS` never alters an existing table, so this line governs NEW tables
// only. An existing deployment keeps the old numbering until
// `apps/api/scripts/migrate-usage-status-enum.ts` is run against it. That
// migration RAN on 2026-09-29 against production: this declaration is now what
// the deployed `fact_machine_usage` actually carries, verified with `DESCRIBE
// TABLE`. It is not idempotent and must not be re-run — the script refuses an
// already-migrated column. `ALTER TABLE ... MODIFY COLUMN` is NOT the way to do
// it: ClickHouse either refuses the renumbering (Code 70, CANNOT_CONVERT_TYPE,
// verified on 26.3) or, on older builds, leaves parts under inconsistent enums.
// The migration rebuilds the column instead, dropping and rebuilding the
// `proj_by_time` projection around the swap and requiring the ETL to be held
// still — see `deploy/etl/hold-etl-for-warehouse-migration.sh`.
//
// Note also that IRIS's own written enums are stale in the OTHER direction:
// packages/contracts/src/sync.ts:55,64 and docs/05-database-schema.md:246 list
// only five values and omit `admitted`, while ingest.ts actively handles it
// (4577, 4647, 4668, 4700, 4723). Upstream `machine_usage.status` is plain
// `text NOT NULL` with no DB CHECK, so there is no upstream constraint to
// appeal to — this table is where the six values are actually pinned down.
//
// attribution_state below is NOT IRIS's taxonomy. IRIS constrains
// machine_usage.attribution_state to ('pending','resolved','unknown','conflict')
// (migration 0052, never altered since); 'pending_attribution' belongs to a
// different table, wdf_lifecycle_binding. The four values declared in
// FACT_USAGE_COLUMNS are LaundryTwin's own evidence classes, DERIVED by
// transform.ts::deriveAttributionState from machine_usage.attribution_reason —
// IRIS has no column carrying them.

export type Column = { name: string; ch: string };

const DIM_BRANCH_COLUMNS: Column[] = [
  { name: "tenant_id", ch: "UUID" },
  { name: "branch_id", ch: "UUID" },
  { name: "branch_name", ch: "String" },
  { name: "timezone", ch: "String" },
  { name: "active", ch: "UInt8" },
  { name: "source_updated_at", ch: "DateTime64(3)" },
  { name: "extracted_at", ch: "DateTime64(3)" },
];

// Weather source location per branch (F-12, per-branch collection since
// 2026-09-10). NOT part of the IRIS-synced dim_branch: the ETL transform
// emits only what the source provides (province/lat/lon/sub_district
// are provisioned here manually, never guessed), so this table is
// written by ops, not ETL.
//
// `version` is a monotonically increasing revision counter (ops bumps it when
// it re-provisions a row). It must NOT be `province`: ReplacingMergeTree
// requires the version column to be an integer or Date/DateTime, and a String
// version column makes the CREATE fail with Code 169 BAD_TYPE_OF_FIELD, which
// aborts runEtl before any fact table exists (see the ETL startup order in
// ./run.ts: every CREATE runs first, then the load).
const DIM_BRANCH_LOCATION_COLUMNS: Column[] = [
  { name: "tenant_id", ch: "UUID" },
  { name: "branch_id", ch: "UUID" },
  { name: "province", ch: "String" },
  { name: "sub_district", ch: "Nullable(String)" },
  { name: "district", ch: "Nullable(String)" },
  { name: "lat", ch: "Float64" },
  { name: "lon", ch: "Float64" },
  { name: "version", ch: "UInt32" },
];

const DIM_MACHINE_COLUMNS: Column[] = [
  { name: "tenant_id", ch: "UUID" },
  { name: "branch_id", ch: "UUID" },
  { name: "machine_id", ch: "UUID" },
  { name: "machine_code", ch: "String" },
  { name: "machine_kind", ch: "Enum8('washer' = 1, 'dryer' = 2)" },
  { name: "modbus_address", ch: "UInt16" },
  { name: "active", ch: "UInt8" },
  { name: "source_updated_at", ch: "DateTime64(3)" },
  { name: "extracted_at", ch: "DateTime64(3)" },
];

const FACT_USAGE_COLUMNS: Column[] = [
  { name: "tenant_id", ch: "UUID" },
  { name: "branch_id", ch: "UUID" },
  { name: "machine_id", ch: "UUID" },
  { name: "usage_id", ch: "UUID" },
  { name: "source_event_id", ch: "String" },
  { name: "machine_session_id", ch: "Nullable(String)" },
  { name: "started_at", ch: "Nullable(DateTime64(3))" },
  { name: "finished_at", ch: "Nullable(DateTime64(3))" },
  { name: "duration_min", ch: "UInt16" },
  { name: "program_id", ch: "Int16" },
  { name: "program_name", ch: "String" },
  { name: "temp_level", ch: "Nullable(Enum8('cold' = 1, 'warm' = 2, 'hot' = 3, 'low' = 4, 'medium' = 5, 'high' = 6))" },
  { name: "amount_satang", ch: "Int64" },
  { name: "status", ch: "Enum8('pending_payment' = 1, 'paid' = 2, 'admitted' = 3, 'running' = 4, 'finished' = 5, 'cancelled' = 6)" },
  { name: "initiated_via", ch: "Enum8('staff_v3' = 1, 'liff' = 2, 'kiosk_k2' = 3, 'coin' = 4)" },
  { name: "attribution_state", ch: "Nullable(Enum8('exact' = 1, 'legacy' = 2, 'heuristic' = 3, 'pending_attribution' = 4))" },
  { name: "attribution_source", ch: "Nullable(Enum8('staff_v3' = 1, 'liff' = 2, 'handheld_dispatch' = 3, 'unknown' = 4))" },
  { name: "source_created_at", ch: "DateTime64(3)" },
  { name: "source_updated_at", ch: "DateTime64(3)" },
  { name: "extracted_at", ch: "DateTime64(3)" },
];

const FACT_TEMPERATURE_COLUMNS: Column[] = [
  { name: "tenant_id", ch: "UUID" },
  { name: "branch_id", ch: "UUID" },
  { name: "machine_id", ch: "String" },
  { name: "event_id", ch: "String" },
  { name: "seq", ch: "UInt64" },
  { name: "frame_seq", ch: "Nullable(UInt64)" },
  { name: "occurred_at", ch: "DateTime64(3)" },
  { name: "ingested_at", ch: "DateTime64(3)" },
  { name: "temperature_f", ch: "Int16" },
  { name: "temperature_c", ch: "Nullable(Float32)" },
  { name: "phase", ch: "Nullable(String)" },
  { name: "extracted_at", ch: "DateTime64(3)" },
];

// Weather observations from the TMD NWP API (F-12, Phase 2). Nullable
// readings: a missing field stays NULL — never fabricated. Versioned by the
// observation timestamp so a re-run converges to one row per (branch, ts).
// tenant_id/branch_id link the observation to a registered branch (dim_branch);
// province is retained as the source-location label returned by TMD.
// sub_district and district are reserved for future per-position data (nullable).
const FACT_WEATHER_COLUMNS: Column[] = [
  { name: "timestamp", ch: "DateTime64(3)" },
  { name: "tenant_id", ch: "UUID" },
  { name: "branch_id", ch: "UUID" },
  { name: "province", ch: "Nullable(String)" },
  { name: "sub_district", ch: "Nullable(String)" },
  { name: "district", ch: "Nullable(String)" },
  { name: "weather_temp_c", ch: "Nullable(Float32)" },
  { name: "weather_humidity_pct", ch: "Nullable(Float32)" },
  { name: "weather_rain_mm", ch: "Nullable(Float32)" },
  { name: "weather_cond", ch: "Nullable(Int32)" },
];

// Gas pressure samples from Home Assistant (branch `otterimju2`). This is a
// SEPARATE, ADDITIVE source: usage still comes from IRIS Postgres via the main
// ETL, and nothing in the Digital Twin or the usage KPIs is derived from this
// table. Provenance is different and the two must never be conflated — see
// docs/03_data_contracts/ha_gas_sensor_contract.md.
//
// The three entities are the two gas-run manifold pressures and the gas FILTER
// differential pressure. `channel` is the semantic label and is deliberately
// NOT derivable from the entity id: `sensor.*_changeover_pressure` is the
// filter, not a changeover pressure, and the id alone is misleading.
//
// `value_psi` is NULLABLE and that is load-bearing. Home Assistant reports
// `unavailable` as the literal string state when the reading is missing. The
// true numeric minimum observed across 2026-09-22..30 is 9 psi, so coercing
// the sentinel to 0 would fabricate an "empty tank" reading that is 9 psi
// away from the truth. `state_raw` keeps the exact source string so the
// distinction survives into the warehouse and stays auditable.
//
// The `gas_detector_*` binary sensors are DELIBERATELY absent. Measured
// 2026-09-30: they toggle on a 50.00-50.03% daily ratio every day with a fixed
// 5-25s cadence and constant attributes — a liveness heartbeat, not a leak
// detector. There is no leak signal in that source and ingesting it would
// manufacture a "leak half the time" reading. Do not add it here.
//
// Idempotency: ReplacingMergeTree versioned by ingested_at, keyed on
// (tenant_id, branch_id, channel, recorded_at), so re-polling an overlapping
// window converges to one row per sample and a later re-read wins.
const FACT_GAS_COLUMNS: Column[] = [
  { name: "tenant_id", ch: "UUID" },
  { name: "branch_id", ch: "UUID" },
  // Operator-facing source-site name, e.g. 'otterimju2'. branch_id remains the
  // join key everywhere; this exists so the site can be found by the name the
  // shop actually uses without a second lookup table.
  { name: "branch_slug", ch: "String" },
  { name: "channel", ch: "Enum8('gas_run_a_pressure' = 1, 'gas_run_b_pressure' = 2, 'changeover_filter_pressure' = 3)" },
  { name: "entity_id", ch: "String" },
  { name: "unit", ch: "LowCardinality(String)" },
  { name: "value_psi", ch: "Nullable(Float32)" },
  // The exact Home Assistant state string, including 'unavailable'.
  { name: "state_raw", ch: "String" },
  { name: "is_available", ch: "UInt8" },
  // When the recorder stored the sample. Home Assistant returns offset-aware
  // ISO timestamps, so this is a true UTC instant, not shop wall-clock.
  { name: "recorded_at", ch: "DateTime64(3)" },
  { name: "ingested_at", ch: "DateTime64(3)" },
];

function ddl(
  table: string,
  columns: Column[],
  engine: string,
  orderBy: string,
  partitionBy?: string,
  version?: string
): string {
  const cols = columns.map((c) => `    ${c.name} ${c.ch}`).join(",\n");
  const versionClause = version ? `(${version})` : "";
  const partitionClause = partitionBy ? `\nPARTITION BY ${partitionBy}` : "";
  return `CREATE TABLE IF NOT EXISTS ${table} (\n${cols}\n) ENGINE = ${engine}${versionClause}${partitionClause}\n  ORDER BY ${orderBy}`;
}

export const CREATE_TABLES: string[] = [
  ddl("dim_branch", DIM_BRANCH_COLUMNS, "ReplacingMergeTree", "(tenant_id, branch_id)", undefined, "source_updated_at"),
  ddl("dim_branch_location", DIM_BRANCH_LOCATION_COLUMNS, "ReplacingMergeTree", "(tenant_id, branch_id)", undefined, "version"),
  ddl("dim_machine", DIM_MACHINE_COLUMNS, "ReplacingMergeTree", "(tenant_id, branch_id, machine_id)", undefined, "source_updated_at"),
  ddl(
    "fact_machine_usage",
    FACT_USAGE_COLUMNS,
    "ReplacingMergeTree",
    "(tenant_id, branch_id, usage_id)",
    undefined,
    "source_updated_at"
  ),
  ddl(
    "fact_temperature_sample",
    FACT_TEMPERATURE_COLUMNS,
    "MergeTree",
    "(tenant_id, branch_id, occurred_at, event_id)",
    "toYYYYMM(occurred_at)"
  ),
  ddl(
    "fact_weather_sample",
    FACT_WEATHER_COLUMNS,
    "ReplacingMergeTree",
    "(tenant_id, branch_id, timestamp)",
    undefined,
    "timestamp"
  ),
  ddl(
    "fact_gas_pressure_sample",
    FACT_GAS_COLUMNS,
    "ReplacingMergeTree",
    "(tenant_id, branch_id, channel, recorded_at)",
    "toYYYYMM(recorded_at)",
    "ingested_at"
  ),
];

export const TABLE_COLUMNS: Record<string, string[]> = {
  dim_branch: DIM_BRANCH_COLUMNS.map((c) => c.name),
  dim_branch_location: DIM_BRANCH_LOCATION_COLUMNS.map((c) => c.name),
  dim_machine: DIM_MACHINE_COLUMNS.map((c) => c.name),
  fact_machine_usage: FACT_USAGE_COLUMNS.map((c) => c.name),
  fact_temperature_sample: FACT_TEMPERATURE_COLUMNS.map((c) => c.name),
  fact_weather_sample: FACT_WEATHER_COLUMNS.map((c) => c.name),
  fact_gas_pressure_sample: FACT_GAS_COLUMNS.map((c) => c.name),
};

export const TABLE_NAMES = Object.keys(TABLE_COLUMNS) as Array<keyof typeof TABLE_COLUMNS>;
