import { describe, expect, it, vi } from "vitest";
import type { ClickHouseExecutor } from "../analytics/clickhouse";
import {
  buildBranchSQL,
  buildDashboardSQL,
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

  // CANONICAL CYCLE DEFINITION (decided 2026-09-29, see
  // docs/04_traceability/RTM_matrix.md "Canonical cycle definition").
  //
  // `machine_session_id` is nullable and NULL on 63.91% of real usage rows
  // (2,849 of 4,458, measured 2026-09-29 over 2026-07-22 → 2026-09-25), so a
  // distinct-session count silently drops two thirds of the work: the real
  // warehouse's revenue divided by uniqExactIf gave ฿125.42/cycle, about three
  // times a real Thai wash, while the row count gave ฿42.20. Those are the
  // figures the 2026-09-29 decision rests on. Re-measured 2026-09-30 11:39:11
  // UTC over 7,908 rows: NULL share 67.8933% (5,369), ฿203.05 over 1,589
  // session-distinct cycles vs ฿48.40 over 6,666 rows — the row-count figure
  // is now ABOVE the plausible ฿40–45 band, so the refreshed price band does
  // not re-confirm the decision; the ranking is unchanged and the cardinality
  // argument below is what carries it. The measured cardinality makes rows and
  // sessions equivalent for attributed rows — one session id is exactly one
  // row — so counting rows counts every session and loses nothing that had
  // evidence. That 1:1 shape was measured 2026-09-29 and not re-measured
  // since. Every figure here is a point-in-time measurement of a live metric;
  // never quote one without its date.
  it("counts cycles as usage rows in the paid/finished statuses, not distinct session ids", () => {
    const sql = buildDashboardSQL();

    expect(sql).toContain("countIf(u.status IN ('paid', 'finished')) AS cycles");
    expect(sql).not.toMatch(/uniqExactIf|countDistinct\(u\.machine_session_id\)/);
    // Machine grain is preserved — per-machine counts still sum to the total.
    expect(sql).not.toMatch(/GROUP BY[^;]*\bu\.status\b/);
    expect(sql).toContain("GROUP BY u.tenant_id, u.branch_id, u.machine_id, b.branch_name, m.machine_code, m.machine_kind");
  });

  // The paid/finished filter is written with string literals, not the enum
  // numbers. `status IN (2, 4)` was correct only while the enum was declared
  // 'running'=3, 'finished'=4; the enum is now numbered by the IRIS lifecycle
  // order (admitted=3, running=4, finished=5), which would have silently
  // turned that filter into `paid` + `running`. ClickHouse resolves a string
  // literal against the Enum8 by name, so the names cannot drift.
  it("filters the cycle statuses by name, never by enum number", () => {
    for (const sql of [buildDashboardSQL(), buildMachineStateSQL()]) {
      expect(sql).not.toMatch(/status\s+(?:NOT\s+)?IN\s*\(\s*\d/);
      expect(sql).not.toMatch(/status\s*(?:=|==|!=|<|>)\s*\d/);
      expect(sql).toContain("status IN ('paid', 'finished')");
    }
  });

  // A row count is only right if the evidence gap is visible. The gap is
  // measurable: the warehouse can count the counted rows that carry a
  // non-null machine_session_id, so the API reports it rather than leaving a
  // reader to assume the total is complete.
  it("counts the subset of counted rows that carry a machine_session_id", () => {
    const sql = buildDashboardSQL();

    expect(sql).toContain(
      "countIf(u.status IN ('paid', 'finished') AND u.machine_session_id IS NOT NULL) AS attributedCycles"
    );
  });

  it("reports cycle attribution as the counted rows and how many carry a session id", async () => {
    const executor = vi
      .fn()
      .mockResolvedValueOnce([
        {
          tenant_id: "tenant-01",
          branch_id: "branch-01",
          machine_id: "W1",
          branch_name: "Branch A",
          machine_code: "W1",
          machine_kind: "washer",
          revenueSatang: "0",
          cycles: "900",
          attributedCycles: "120",
          usageRows: "1200",
          started_at: "2026-09-24 08:00:00",
          last_active_at: "2026-09-24 08:00:00"
        }
      ])
      .mockResolvedValueOnce([]);
    const ch = executor as unknown as ClickHouseExecutor;

    const result = await queryDashboard(ch, "2026-07-22", "2026-09-25");

    expect(result.cycleAttribution).toEqual({
      countedRows: 900,
      attributedRows: 120,
      unattributedRows: 780
    });
  });

  // The twin tab and the KPI are one screen. Two different definitions for one
  // word was the defect, so the machine-state query takes the same grain and
  // the same status filter as the dashboard.
  it("counts machine cycles at the same grain and with the same status filter as the dashboard", () => {
    const sql = buildMachineStateSQL();

    expect(sql).toContain("countIf(u.status IN ('paid', 'finished')) AS cycle_count");
    expect(sql).not.toContain("countDistinct(u.machine_session_id)");
  });

  it("labels a machine cycle count with the definition it was taken from", async () => {
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

    // Not "machine_session_id": the count is no longer taken from that field.
    expect(result[0]).toMatchObject({ cycleCount: 4, cycleCountSource: "usage_row" });
  });

  it("keeps the status filter and the revenue sum untouched while dropping the status grouping key", () => {
    const sql = buildDashboardSQL();

    // docs/03_data_contracts/data_contracts.md: revenue and cycle counts
    // legitimately include both `paid` and `finished`. The filter must survive.
    expect(sql).toContain("sumIf(u.amount_satang, u.status IN ('paid', 'finished')) AS revenueSatang");
    // Revenue is separately correct and separately verified against Superset;
    // this fix must not move it.
    expect(sql).not.toContain("u.status AS status,");
  });

  it("still counts usage rows for presence, not machine groups", () => {
    // Dropping the status grouping key must not collapse count() into a
    // per-machine existence flag: presence is a row count.
    expect(buildDashboardSQL()).toContain("count() AS usageRows");
  });

  it("binds the per-group usage count into the existing dashboard query", async () => {
    const executor = vi.fn().mockResolvedValue([]);
    const ch = executor as unknown as ClickHouseExecutor;

    await queryDashboard(ch, "2026-09-18", "2026-09-25", "branch-01");

    const [sql] = executor.mock.calls[0] as [string, Record<string, string>];
    expect(sql).toContain("count() AS usageRows");
  });

  it("returns cycle count and source for a machine with usage evidence", async () => {
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
      cycleCountSource: "usage_row"
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
  // known. cancelled (Enum8=6) and admitted (Enum8=3) are documented members of
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
