import { describe, expect, it } from "vitest";
import {
  fahrenheitToCelsius,
  toClickHouseDateTime,
  toClickHouseDateTimeNullable,
  toDimBranch,
  toDimMachine,
  toFactMachineUsage,
  toFactTemperatureSample,
} from "../src/transform.js";
import type {
  BranchRow,
  MachineRow,
  TemperatureSampleRow,
  UsageRow,
} from "../src/postgres.js";

const EXTRACTED = new Date("2026-08-29T08:00:00.000Z");
const FIXED = (s: string) => new Date(s);

describe("transform", () => {
  it("converts Fahrenheit to Celsius rounded to 2dp", () => {
    expect(fahrenheitToCelsius(92)).toBe(33.33);
    expect(fahrenheitToCelsius(32)).toBe(0);
    expect(fahrenheitToCelsius(212)).toBe(100);
  });

  it("formats a Date as ClickHouse DateTime64 text", () => {
    expect(toClickHouseDateTime(new Date("2026-08-29T07:47:25.095Z"))).toBe("2026-08-29 07:47:25.095");
  });

  it("keeps null timestamps as null instead of fabricating a value", () => {
    expect(toClickHouseDateTimeNullable(null)).toBeNull();
  });

  it("maps a BranchRow to a dim_branch row", () => {
    const row: BranchRow = {
      tenant_id: "ten1",
      branch_id: "br1",
      name: "Otteri",
      timezone: "Asia/Bangkok",
      status: "active",
      updated_at: FIXED("2026-08-29T01:00:00.000Z"),
    };
    expect(toDimBranch(row, EXTRACTED)).toEqual({
      tenant_id: "ten1",
      branch_id: "br1",
      branch_name: "Otteri",
      timezone: "Asia/Bangkok",
      active: 1,
      source_updated_at: "2026-08-29 01:00:00.000",
      extracted_at: "2026-08-29 08:00:00.000",
    });
  });

  it("marks an inactive branch active=0", () => {
    const row: BranchRow = {
      tenant_id: "ten1",
      branch_id: "br1",
      name: "Closed",
      timezone: "Asia/Bangkok",
      status: "suspended",
      updated_at: FIXED("2026-08-29T01:00:00.000Z"),
    };
    expect(toDimBranch(row, EXTRACTED).active).toBe(0);
  });

  it("drops deleted machines from dim_machine", () => {
    const row: MachineRow = {
      tenant_id: "ten1",
      branch_id: "br1",
      machine_id: "m1",
      code: "W1",
      kind: "washer",
      modbus_address: 3,
      status: "active",
      updated_at: FIXED("2026-08-29T01:00:00.000Z"),
      deleted_at: FIXED("2026-08-28T00:00:00.000Z"),
    };
    expect(toDimMachine(row, EXTRACTED)).toBeNull();
  });

  it("maps an active MachineRow to dim_machine", () => {
    const row: MachineRow = {
      tenant_id: "ten1",
      branch_id: "br1",
      machine_id: "m1",
      code: "W1",
      kind: "washer",
      modbus_address: 3,
      status: "active",
      updated_at: FIXED("2026-08-29T01:00:00.000Z"),
      deleted_at: null,
    };
    expect(toDimMachine(row, EXTRACTED)).toEqual({
      tenant_id: "ten1",
      branch_id: "br1",
      machine_id: "m1",
      machine_code: "W1",
      machine_kind: "washer",
      modbus_address: 3,
      active: 1,
      source_updated_at: "2026-08-29 01:00:00.000",
      extracted_at: "2026-08-29 08:00:00.000",
    });
  });

  it("maps a UsageRow to fact_machine_usage preserving satang and null optics", () => {
    const row: UsageRow = {
      tenant_id: "ten1",
      branch_id: "br1",
      machine_id: "m1",
      usage_id: "usage-1",
      program_id: 2,
      program_name: "standard",
      started_at: FIXED("2026-08-28T07:47:25.095Z"),
      finished_at: FIXED("2026-08-28T08:27:25.095Z"),
      duration_min: 40,
      amount_satang: 40000,
      status: "finished",
      initiated_via: "liff",
      temp_level: "hot",
      attribution_state: "resolved",
      attribution_reason: "exact_edge_lifecycle",
      attribution_source: "liff",
      machine_session_id: "sess-9",
      source_event_id: "evt-1",
      created_at: FIXED("2026-08-28T09:00:00.000Z"),
      updated_at: FIXED("2026-08-28T09:05:00.000Z"),
    };
    expect(toFactMachineUsage(row, EXTRACTED)).toEqual({
      tenant_id: "ten1",
      branch_id: "br1",
      machine_id: "m1",
      usage_id: "usage-1",
      source_event_id: "evt-1",
      machine_session_id: "sess-9",
      started_at: "2026-08-28 07:47:25.095",
      finished_at: "2026-08-28 08:27:25.095",
      duration_min: 40,
      program_id: 2,
      program_name: "standard",
      temp_level: "hot",
      amount_satang: 40000,
      status: "finished",
      initiated_via: "liff",
      attribution_state: "exact",
      attribution_source: "liff",
      source_created_at: "2026-08-28 09:00:00.000",
      source_updated_at: "2026-08-28 09:05:00.000",
      extracted_at: "2026-08-29 08:00:00.000",
    });
  });

  it("keeps unstarted usage as started_at null (evidence, not epoch)", () => {
    const row: UsageRow = {
      tenant_id: "t",
      branch_id: "b",
      machine_id: "m",
      usage_id: "u",
      program_id: 1,
      program_name: "quick",
      started_at: null,
      finished_at: null,
      duration_min: 10,
      amount_satang: 100,
      status: "pending",
      initiated_via: "coin",
      temp_level: null,
      attribution_state: "pending",
      attribution_reason: null,
      attribution_source: null,
      machine_session_id: null,
      source_event_id: "s",
      created_at: FIXED("2026-08-28T09:00:00.000Z"),
      updated_at: FIXED("2026-08-28T09:05:00.000Z"),
    };
    const out = toFactMachineUsage(row, EXTRACTED);
    expect(out.started_at).toBeNull();
    expect(out.finished_at).toBeNull();
    expect(out.temp_level).toBeNull();
    expect(out.initiated_via).toBe("coin");
    expect(out.attribution_state).toBe("pending_attribution");
    expect(out.attribution_source).toBe("unknown");
  });

  it("maps a temperature sample to fact_temperature_sample with both units", () => {
    const row: TemperatureSampleRow = {
      tenant_id: "ten1",
      branch_id: "br1",
      machine_id: "m1",
      event_id: "sample-1",
      seq: "1000",
      frame_seq: "7",
      occurred_at: FIXED("2026-08-28T07:00:00.000Z"),
      ingested_at: FIXED("2026-08-28T07:00:05.000Z"),
      temperature_f: 92,
      phase: "wash",
    };
    expect(toFactTemperatureSample(row, EXTRACTED)).toEqual({
      tenant_id: "ten1",
      branch_id: "br1",
      machine_id: "m1",
      event_id: "sample-1",
      seq: "1000",
      frame_seq: "7",
      occurred_at: "2026-08-28 07:00:00.000",
      ingested_at: "2026-08-28 07:00:05.000",
      temperature_f: 92,
      temperature_c: 33.33,
      phase: "wash",
      extracted_at: "2026-08-29 08:00:00.000",
    });
  });
});