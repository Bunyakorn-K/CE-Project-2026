// ClickHouse target schema — mirrored from the LIVE warehouse
// (`laundrytwin_analytics` on VM 117). These tables already exist with this
// exact DDL; this module is the source of truth the ETL INSERTs against and,
// for a fresh environment, what it would create. We deliberately do NOT emit a
// `CREATE TABLE IF NOT EXISTS` at runtime that could diverge from a live table;
// the ETL assumes the schema below (and validated extra enum members) is present.
//
// Idempotency: fact tables are ReplacingMergeTree versioned by the source row's
// own updated_at (ingested_at for temperature), so a re-insert converges to one
// row. Money stays integer satang; temperature_f is the raw integer from the
// source and temperature_c the derived Celsius. Missing data stays NULL — we
// never fabricate a value.
//
// Enum members (validated live / aligned with IRIS source):
//   status         pending_payment, paid, running, finished, cancelled, admitted
//   initiated_via  staff_v3, liff, kiosk_k2, coin
//   temp_level     cold, warm, hot, low, medium, high
//   machine_kind   washer, dryer
//   attribution_state   exact, legacy, heuristic, pending_attribution
//   attribution_source  staff_v3, liff, handheld_dispatch, unknown

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
  { name: "status", ch: "Enum8('pending_payment' = 1, 'paid' = 2, 'running' = 3, 'finished' = 4, 'cancelled' = 5, 'admitted' = 6)" },
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
];

export const TABLE_COLUMNS: Record<string, string[]> = {
  dim_branch: DIM_BRANCH_COLUMNS.map((c) => c.name),
  dim_machine: DIM_MACHINE_COLUMNS.map((c) => c.name),
  fact_machine_usage: FACT_USAGE_COLUMNS.map((c) => c.name),
  fact_temperature_sample: FACT_TEMPERATURE_COLUMNS.map((c) => c.name),
};

export const TABLE_NAMES = Object.keys(TABLE_COLUMNS) as Array<keyof typeof TABLE_COLUMNS>;
