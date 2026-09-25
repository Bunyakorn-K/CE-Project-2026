import { describe, expect, it, vi } from "vitest";
import type { ClickHouseExecutor } from "../analytics/clickhouse";
import { buildMachineStateSQL, queryBranches, queryDashboard, queryMachineStates } from "./clickhouse-report";

function fakeExecutor(rows: Record<string, unknown>[]): ClickHouseExecutor {
  return vi.fn().mockResolvedValue(rows) as unknown as ClickHouseExecutor;
}

describe("machine floor report", () => {
  it("binds dates and branch scope while retaining inventory without usage", () => {
    const sql = buildMachineStateSQL();

    expect(sql).toContain("countDistinct(u.machine_session_id) AS cycle_count");
    expect(sql).toContain("LEFT JOIN fact_machine_usage AS u FINAL");
    expect(sql).toContain("u.started_at >= {from:String}");
    expect(sql).toContain("u.started_at < plus(toDate({to:String}), 1)");
    expect(sql).toContain("toString(m.branch_id) = {branchId:String}");
    expect(sql).toContain("m.branch_id = u.branch_id");
    expect(sql).not.toContain("2026-09-18");
    expect(sql).not.toContain("2026-09-25");
    expect(sql).not.toContain("branch-01");
  });

  it("maps ClickHouse branch metadata without dropping timezone", async () => {
    const ch = fakeExecutor([
      {
        branch_id: "branch-01",
        branch_name: "Branch 01",
        branch_code: "01",
        timezone: "Asia/Bangkok",
        active: "1"
      }
    ]);

    await expect(queryBranches(ch)).resolves.toEqual([
      {
        branchId: "branch-01",
        branchName: "Branch 01",
        branchCode: "01",
        timezone: "Asia/Bangkok",
        active: true
      }
    ]);
  });

  it("passes dashboard dates and branch scope as ClickHouse parameters", async () => {
    const executor = vi.fn().mockResolvedValue([]);
    const ch = executor as unknown as ClickHouseExecutor;

    await queryDashboard(ch, "2026-09-18", "2026-09-25", "branch-01");

    const [sql, params] = executor.mock.calls[0] as [string, Record<string, string>];
    expect(params).toEqual({ from: "2026-09-18", to: "2026-09-25", branchId: "branch-01" });
    expect(sql).toContain("toString(u.branch_id) = {branchId:String}");
    expect(sql).toContain("u.branch_id = m.branch_id");
    expect(sql).toContain("u.started_at < plus(toDate({to:String}), 1)");
    expect(sql).not.toContain("2026-09-18");
    expect(sql).not.toContain("2026-09-25");
    expect(sql).not.toContain("branch-01");
  });

  it("returns cycle count and source for a machine with session evidence", async () => {
    const ch = fakeExecutor([
      {
        machine_code: "W3",
        machine_kind: "washer",
        branch_name: "Branch A",
        status: "finished",
        last_active_at: "2026-09-24 08:00:00",
        cycle_count: "4"
      }
    ]);

    const result = await queryMachineStates(ch, "2026-09-18", "2026-09-25");

    expect(result[0]).toMatchObject({
      machineCode: "W3",
      status: "paid",
      cycleCount: 4,
      cycleCountSource: "machine_session_id"
    });
  });

  it("does not invent a cycle count without session evidence", async () => {
    const ch = fakeExecutor([
      {
        machine_code: "D3",
        machine_kind: "dryer",
        branch_name: "Branch A",
        status: "pending_payment",
        last_active_at: "2026-09-24 08:00:00",
        cycle_count: "0"
      }
    ]);

    const result = await queryMachineStates(ch, "2026-09-18", "2026-09-25");

    expect(result[0]).toMatchObject({ cycleCount: null, cycleCountSource: "unavailable" });
  });

  it("keeps an unknown machine state unknown", async () => {
    const ch = fakeExecutor([
      {
        machine_id: "machine-01",
        branch_id: "branch-01",
        machine_code: "W1",
        machine_kind: "washer",
        branch_name: "Branch A",
        status: "unrecognized",
        last_active_at: "2026-09-24 08:00:00",
        cycle_count: "1"
      }
    ]);

    const result = await queryMachineStates(ch, "2026-09-18", "2026-09-25");

    expect(result[0]?.status).toBe("unknown");
  });

  it("retains active inventory with no usage as unavailable evidence", async () => {
    const ch = fakeExecutor([
      {
        machine_id: "machine-01",
        branch_id: "branch-01",
        machine_code: "W1",
        machine_kind: "washer",
        branch_name: "Branch A",
        status: null,
        last_active_at: null,
        cycle_count: "0"
      }
    ]);

    const result = await queryMachineStates(ch, "2026-09-18", "2026-09-25");

    expect(result).toEqual([
      {
        tenantId: "unknown",
        machineId: "machine-01",
        branchId: "branch-01",
        machineCode: "W1",
        machineKind: "washer",
        branchName: "Branch A",
        status: "unknown",
        lastActiveAt: null,
        cycleCount: null,
        cycleCountSource: "unavailable"
      }
    ]);
  });
});
