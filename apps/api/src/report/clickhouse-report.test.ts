import { describe, expect, it, vi } from "vitest";
import type { ClickHouseExecutor } from "../analytics/clickhouse";
import {
  buildBranchSQL,
  buildMachineStateSQL,
  queryBranches,
  queryDashboard,
  queryMachineStates
} from "./clickhouse-report";

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
        timezone: "Asia/Bangkok",
        active: "1"
      }
    ]);

    await expect(queryBranches(ch)).resolves.toEqual([
      {
        branchId: "branch-01",
        branchName: "Branch 01",
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

  // The dashboard aggregates usage into one row per (machine, status) group, so
  // a zero-length result set only proves absence. Reporting `rows.length` as
  // "usage rows" would report a group count for every non-empty window, which is
  // the same kind of dishonest number this signal exists to replace.
  it("reports zero usage rows in range when the aggregated usage query returns nothing", async () => {
    const executor = vi.fn().mockResolvedValue([]);
    const ch = executor as unknown as ClickHouseExecutor;

    const result = await queryDashboard(ch, "2026-09-25", "2026-10-01");

    expect(result.usageRowsInRange).toBe(0);
  });

  it("counts the usage rows behind the totals rather than the number of machine/status groups", async () => {
    const usageRow = (machineId: string, status: string, usageRows: string) => ({
      tenant_id: "tenant-01",
      branch_id: "branch-01",
      machine_id: machineId,
      branch_name: "Branch A",
      machine_code: machineId,
      machine_kind: "washer",
      status,
      revenueSatang: "0",
      cycles: "0",
      usageRows,
      started_at: "2026-09-24 08:00:00",
      last_active_at: "2026-09-24 08:00:00"
    });
    const executor = vi
      .fn()
      .mockResolvedValueOnce([usageRow("W1", "paid", "1200"), usageRow("W1", "running", "12")])
      .mockResolvedValueOnce([
        {
          tenant_id: "tenant-01",
          machine_id: "W1",
          branch_id: "branch-01",
          machine_code: "W1",
          machine_kind: "washer",
          branch_name: "Branch A",
          status: "paid",
          last_active_at: "2026-09-24 08:00:00",
          cycle_count: "900"
        }
      ]);
    const ch = executor as unknown as ClickHouseExecutor;

    const result = await queryDashboard(ch, "2026-07-01", "2026-08-25");

    expect(result.usageRowsInRange).toBe(1212);
  });

  it("binds the per-group usage count into the existing dashboard query", async () => {
    const executor = vi.fn().mockResolvedValue([]);
    const ch = executor as unknown as ClickHouseExecutor;

    await queryDashboard(ch, "2026-09-18", "2026-09-25", "branch-01");

    const [sql] = executor.mock.calls[0] as [string, Record<string, string>];
    expect(sql).toContain("count() AS usageRows");
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
      status: "finished",
      cycleCount: 4,
      cycleCountSource: "machine_session_id"
    });
  });

  // `paid_ratio` in docs/06_ml/ml-training-data-guide.md is
  // countIf(status='paid') / countIf(status IN ('finished','paid')). That ratio
  // is meaningless if the API reports both enums as the single value "paid", so
  // a finished session must stay distinguishable from a paid one.
  it("keeps a finished session distinct from a paid session", async () => {
    const ch = fakeExecutor([
      {
        machine_id: "machine-01",
        branch_id: "branch-01",
        machine_code: "W1",
        machine_kind: "washer",
        branch_name: "Branch A",
        status: "paid",
        last_active_at: "2026-09-24 08:00:00",
        cycle_count: "2"
      },
      {
        machine_id: "machine-02",
        branch_id: "branch-01",
        machine_code: "W2",
        machine_kind: "washer",
        branch_name: "Branch A",
        status: "finished",
        last_active_at: "2026-09-24 09:00:00",
        cycle_count: "3"
      }
    ]);

    const result = await queryMachineStates(ch, "2026-09-18", "2026-09-25");

    expect(result.map((machine) => machine.status)).toEqual(["paid", "finished"]);
  });

  // docs/03_data_contracts/data_contracts.md requires known enums to stay
  // known. cancelled (Enum8=5) and admitted (Enum8=6) are documented members of
  // fact_machine_usage.status (apps/etl/src/schema.ts) and used to fall through
  // to "unknown".
  it("maps the known cancelled and admitted enums instead of degrading them to unknown", async () => {
    const ch = fakeExecutor(
      ["cancelled", "admitted"].map((status, index) => ({
        machine_id: `machine-0${index + 1}`,
        branch_id: "branch-01",
        machine_code: `W${index + 1}`,
        machine_kind: "washer",
        branch_name: "Branch A",
        status,
        last_active_at: "2026-09-24 08:00:00",
        cycle_count: "1"
      }))
    );

    const result = await queryMachineStates(ch, "2026-09-18", "2026-09-25");

    expect(result.map((machine) => machine.status)).toEqual(["cancelled", "admitted"]);
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

describe("branch report", () => {
  it("selects only dim_branch columns and binds the branch scope", () => {
    const sql = buildBranchSQL();
    const selectList = sql.match(/SELECT ([\s\S]+?)\sFROM/)?.[1];

    // dim_branch is IRIS-mirrored (apps/etl/src/schema.ts DIM_BRANCH_COLUMNS):
    // tenant_id, branch_id, branch_name, timezone, active, source_updated_at,
    // extracted_at. There is no branch_code, and a manual column there is
    // overwritten on the next sync. Mock rows used to fabricate one, so this
    // query was never exercised against a real table.
    expect(selectList?.split(",").map((column) => column.trim())).toEqual([
      "branch_id",
      "branch_name",
      "timezone",
      "active"
    ]);
    expect(sql).not.toContain("branch_code");
    expect(sql).toContain("FROM dim_branch FINAL");
    expect(sql).toContain("WHERE active = 1");
    expect(sql).toContain("({branchId:String} = '' OR toString(branch_id) = {branchId:String})");
  });
});
