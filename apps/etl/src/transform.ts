// Pure row mapping from Postgres source shapes to the ClickHouse target
// shapes declared in schema.ts. These functions are side-effect-free so they
// are trivially unit-testable. `extractedAt` is the single extraction
// timestamp written to every row's `extracted_at` column; it defaults to "now"
// but is injectable for deterministic tests.
//
// Enum normalisation (validated against IRIS source, not guessed — see
// /tmp/iris-project, packages/db/schema/transaction.ts and the WDF binding
// code):
//   * status        — wired straight through; admitted/coin now exist in the
//                     warehouse enum so no folding needed.
//   * initiated_via — kiosk_d3_pro (canonical IRIS name replacing kiosk_k2 /
//                     pos_d3) is normalised -> kiosk_k2 to match the warehouse.
//   * attribution_state — derived from attribution_reason (the DB's
//                     pending/resolved binary does not carry the
//                     exact/legacy/heuristic/pending_attribution taxonomy).
//   * attribution_source — NULL->unknown; wdf->handheld_dispatch; payment is
//                     channel-agnostic so it is disambiguated by initiated_via
//                     (liff->liff, staff_v3->staff_v3).

import type {
  BranchRow,
  MachineRow,
  TemperatureSampleRow,
  UsageRow,
} from "./postgres.js";

export type DimBranchRow = {
  tenant_id: string;
  branch_id: string;
  branch_name: string;
  timezone: string;
  active: number;
  source_updated_at: string;
  extracted_at: string;
};

export type DimMachineRow = {
  tenant_id: string;
  branch_id: string;
  machine_id: string;
  machine_code: string;
  machine_kind: string;
  modbus_address: number;
  active: number;
  source_updated_at: string;
  extracted_at: string;
};

export type FactMachineUsageRow = {
  tenant_id: string;
  branch_id: string;
  machine_id: string;
  usage_id: string;
  source_event_id: string;
  machine_session_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_min: number;
  program_id: number;
  program_name: string;
  temp_level: string | null;
  amount_satang: number;
  status: string;
  initiated_via: string;
  attribution_state: string | null;
  attribution_source: string | null;
  source_created_at: string;
  source_updated_at: string;
  extracted_at: string;
};

export type FactTemperatureSampleRow = {
  tenant_id: string;
  branch_id: string;
  machine_id: string;
  event_id: string;
  seq: string;
  frame_seq: string | null;
  occurred_at: string;
  ingested_at: string;
  temperature_f: number;
  temperature_c: number | null;
  phase: string | null;
  extracted_at: string;
};

// DateTime64(3) wants an ISO-ish string; ClickHouse accepts 'YYYY-MM-DD HH:MM:SS.mmm'
// or the same with a 'T'. We emit the closest-to-standard 'YYYY-MM-DD HH:MM:SS.mmm'.
export function toClickHouseDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

// NULL-preserving variant: a missing source timestamp stays NULL in the
// warehouse rather than being invented (an unstarted cycle is evidence, not 0).
export function toClickHouseDateTimeNullable(value: Date | null): string | null {
  return value === null ? null : toClickHouseDateTime(value);
}

export function fahrenheitToCelsius(f: number): number {
  return Math.round(((f - 32) * 5) / 9 * 100) / 100;
}

// initiated_via: IRIS canonical modern kiosk value is kiosk_d3_pro, which
// supersedes kiosk_k2 / pos_d3. The warehouse enum keeps kiosk_k2, so any
// kiosk value normalises here; the raw data in iris_project currently only
// carries staff_v3/liff/coin, but we normalise defensively.
export function normalizeInitiatedVia(value: string): string {
  if (value === "kiosk_d3_pro" || value === "pos_d3") return "kiosk_k2";
  return value;
}

// attribution_state: the DB column is a binary resolved/pending flag; the
// warehouse enum is an evidence-class taxonomy. We classify it from
// attribution_reason (missing identity -> not yet attributed; exact edge
// lifecycle -> exact) and fall back to pending_attribution for anything
// unrecognised rather than mislabelling as exact.
export function deriveAttributionState(reason: string | null | undefined): string | null {
  if (!reason || reason.length === 0) return "pending_attribution";
  switch (reason) {
    case "exact_edge_lifecycle":
      return "exact";
    case "positive_coin_evidence":
      return "heuristic";
    case "legacy_payload":
      return "legacy";
    default:
      return "pending_attribution";
  }
}

// attribution_source: NULL means "not yet attributed" -> unknown; a WDF
// dispatch is by definition the handheld path -> handheld_dispatch; 'payment'
// is channel-agnostic so it is split by initiated_via (liff -> liff, else
// staff-style -> staff_v3). 'coin' attribution (staff later bound a coin
// session) falls back to staff_v3.
export function deriveAttributionSource(
  source: string | null | undefined,
  initiatedVia: string | null | undefined
): string {
  if (!source || source.length === 0) return "unknown";
  switch (source) {
    case "wdf":
      return "handheld_dispatch";
    case "payment":
      return initiatedVia === "liff" ? "liff" : "staff_v3";
    case "coin":
      return "staff_v3";
    case "liff":
    case "staff_v3":
      // Direct channel values already match a warehouse enum member.
      return source;
    default:
      return "unknown";
  }
}

export function toDimBranch(row: BranchRow, extractedAt = new Date()): DimBranchRow {
  return {
    tenant_id: row.tenant_id,
    branch_id: row.branch_id,
    branch_name: row.name,
    timezone: row.timezone,
    active: row.status === "active" ? 1 : 0,
    source_updated_at: toClickHouseDateTime(row.updated_at),
    extracted_at: toClickHouseDateTime(extractedAt),
  };
}

export function toDimMachine(row: MachineRow, extractedAt = new Date()): DimMachineRow | null {
  if (row.deleted_at) return null;
  return {
    tenant_id: row.tenant_id,
    branch_id: row.branch_id,
    machine_id: row.machine_id,
    machine_code: row.code,
    machine_kind: row.kind,
    modbus_address: row.modbus_address,
    active: row.status === "active" ? 1 : 0,
    source_updated_at: toClickHouseDateTime(row.updated_at),
    extracted_at: toClickHouseDateTime(extractedAt),
  };
}

export function toFactMachineUsage(row: UsageRow, extractedAt = new Date()): FactMachineUsageRow {
  return {
    tenant_id: row.tenant_id,
    branch_id: row.branch_id,
    machine_id: row.machine_id,
    usage_id: row.usage_id,
    source_event_id: row.source_event_id,
    machine_session_id: row.machine_session_id ?? null,
    started_at: toClickHouseDateTimeNullable(row.started_at),
    finished_at: toClickHouseDateTimeNullable(row.finished_at),
    duration_min: row.duration_min,
    program_id: row.program_id,
    program_name: row.program_name,
    temp_level: row.temp_level ?? null,
    amount_satang: row.amount_satang,
    status: row.status,
    initiated_via: normalizeInitiatedVia(row.initiated_via),
    attribution_state: deriveAttributionState(row.attribution_reason),
    attribution_source: deriveAttributionSource(row.attribution_source, row.initiated_via),
    source_created_at: toClickHouseDateTime(row.created_at),
    source_updated_at: toClickHouseDateTime(row.updated_at),
    extracted_at: toClickHouseDateTime(extractedAt),
  };
}

export function toFactTemperatureSample(
  row: TemperatureSampleRow,
  extractedAt = new Date()
): FactTemperatureSampleRow {
  return {
    tenant_id: row.tenant_id,
    branch_id: row.branch_id,
    machine_id: row.machine_id,
    event_id: row.event_id,
    seq: row.seq,
    frame_seq: row.frame_seq ?? null,
    occurred_at: toClickHouseDateTime(row.occurred_at),
    ingested_at: toClickHouseDateTime(row.ingested_at),
    temperature_f: row.temperature_f,
    temperature_c:
      row.temperature_f === null || Number.isNaN(row.temperature_f)
        ? null
        : fahrenheitToCelsius(row.temperature_f),
    phase: row.phase ?? null,
    extracted_at: toClickHouseDateTime(extractedAt),
  };
}
