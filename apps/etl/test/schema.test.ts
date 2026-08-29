import { describe, expect, it } from "vitest";
import { TABLE_COLUMNS } from "../src/schema.js";
import {
  toDimBranch,
  toDimMachine,
  toFactMachineUsage,
  toFactTemperatureSample,
  type DimBranchRow,
  type DimMachineRow,
  type FactMachineUsageRow,
  type FactTemperatureSampleRow,
} from "../src/transform.js";
import type { BranchRow, MachineRow, TemperatureSampleRow, UsageRow } from "../src/postgres.js";

// Every transform output column must exactly match the DDL columns for that
// table — otherwise the demo seed (seed-analytics.ts) and the real ETL write
// shapes that diverge and one of them breaks on INSERT. This test locks the
// two to one schema.
const TO = new Date("2026-08-29T08:00:00.000Z");

function branchRow(): BranchRow {
  return {
    tenant_id: "t",
    branch_id: "b",
    name: "N",
    timezone: "Asia/Bangkok",
    status: "active",
    updated_at: TO,
  };
}

function machineRow(): MachineRow {
  return {
    tenant_id: "t",
    branch_id: "b",
    machine_id: "m",
    code: "W1",
    kind: "washer",
    modbus_address: 3,
    status: "active",
    updated_at: TO,
    deleted_at: null,
  };
}

function usageRow(): UsageRow {
  return {
    tenant_id: "t",
    branch_id: "b",
    machine_id: "m",
    usage_id: "u",
    program_id: 1,
    program_name: "quick",
    started_at: TO,
    finished_at: TO,
    duration_min: 10,
    amount_satang: 100,
    status: "finished",
    initiated_via: "liff",
    temp_level: null,
    attribution_state: "resolved",
    attribution_reason: "exact_edge_lifecycle",
    attribution_source: null,
    machine_session_id: null,
    source_event_id: "u:1",
    created_at: TO,
    updated_at: TO,
  };
}

function tempRow(): TemperatureSampleRow {
  return {
    tenant_id: "t",
    branch_id: "b",
    machine_id: "m",
    event_id: "s:1",
    seq: "1000",
    frame_seq: null,
    occurred_at: TO,
    ingested_at: TO,
    temperature_f: 90,
    phase: null,
  };
}

function keys<T extends object>(obj: T): string[] {
  return Object.keys(obj).sort();
}

describe("schema alignment", () => {
  it("dim_branch transform output matches the DDL columns", () => {
    const row: DimBranchRow = toDimBranch(branchRow(), TO);
    expect(keys(row)).toEqual([...TABLE_COLUMNS.dim_branch].sort());
  });

  it("dim_machine transform output matches the DDL columns", () => {
    const row: DimMachineRow | null = toDimMachine(machineRow(), TO);
    expect(row).not.toBeNull();
    expect(keys(row!)).toEqual([...TABLE_COLUMNS.dim_machine].sort());
  });

  it("fact_machine_usage transform output matches the DDL columns", () => {
    const row: FactMachineUsageRow = toFactMachineUsage(usageRow(), TO);
    expect(keys(row)).toEqual([...TABLE_COLUMNS.fact_machine_usage].sort());
  });

  it("fact_temperature_sample transform output matches the DDL columns", () => {
    const row: FactTemperatureSampleRow = toFactTemperatureSample(tempRow(), TO);
    expect(keys(row)).toEqual([...TABLE_COLUMNS.fact_temperature_sample].sort());
  });
});