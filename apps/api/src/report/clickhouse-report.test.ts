import { describe, expect, it, vi } from "vitest";
import type { ClickHouseExecutor } from "../analytics/clickhouse";
import {
  buildBranchSQL,
  buildDashboardSQL,
  buildEventsSQL,
  buildMachineStateSQL,
  encodeEventCursor,
  parseEventCursor,
  queryBranches,
  queryDashboard,
  queryEvents,
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

describe("event feed report", () => {
  it("binds the window and branch scope, and pages on the event identity", () => {
    const sql = buildEventsSQL();

    expect(sql).toContain("FROM fact_machine_event AS e\n");
    expect(sql).toContain("e.occurred_at >= {from:String}");
    // Half-open upper bound, so an event at midnight on the last day of the
    // window is inside the window rather than between two adjacent ranges.
    expect(sql).toContain("e.occurred_at < plus(toDate({to:String}), 1)");
    expect(sql).toContain("({branchId:String} = '' OR toString(e.branch_id) = {branchId:String})");
    // Newest first, and the cursor predicate must compare the SAME pair in the
    // SAME direction or a page walk would skip or repeat rows.
    expect(sql).toContain("ORDER BY e.occurred_at DESC, e.event_id DESC");
    expect(sql).toContain("(e.occurred_at, e.event_id) < ({cursorOccurredAt:String}, {cursorEventId:String})");
    expect(sql).toContain("LIMIT {limit:UInt32}");
  });

  it("reads the event log WITHOUT FINAL but the machine dimension WITH it", () => {
    // Not a style preference. fact_machine_event is a plain MergeTree and
    // ClickHouse rejects FINAL on it outright -- `Storage MergeTree doesn't
    // support FINAL. (ILLEGAL_FINAL)`, measured on production 26.3 -- so
    // copying the modifier from the sibling queries turns this route into a
    // 500 on every call. dim_machine IS a ReplacingMergeTree and needs FINAL
    // to join against current inventory. An append-only log has no duplicate
    // rows to collapse, so omitting FINAL there loses nothing.
    const sql = buildEventsSQL();

    expect(sql).not.toMatch(/fact_machine_event AS e FINAL/);
    expect(sql).toContain("INNER JOIN dim_machine AS m FINAL ON");
  });

  it("joins machine_id across the String/UUID mismatch on the dimension side", () => {
    // machine_id is UUID in dim_machine and String in fact_machine_event, so the
    // bare comparison is rejected outright: "There is no supertype for types
    // UUID, String ... (NO_COMMON_TYPE)", measured on production 26.3. The cast
    // is on the DIMENSION side deliberately: toUUID() would typecheck but throw
    // on any event row whose machine_id is not a parseable UUID, while
    // toString() is total.
    const sql = buildEventsSQL();

    expect(sql).toContain("e.machine_id = toString(m.machine_id)");
    expect(sql).not.toContain("e.machine_id = toUUID(");
    expect(sql).not.toMatch(/e\.machine_id = m\.machine_id/);
  });

  it("asks for one row past the page so 'more' needs no second count query", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({
      event_id: `e${i}`,
      branch_id: "b1",
      machine_id: `m${i}`,
      machine_code: `M-${i}`,
      occurred_at: "2026-09-30 10:00:00",
      kind: "state",
      phase: "running"
    }));
    const ch = fakeExecutor(rows);

    const result = await queryEvents(ch, { from: "2026-09-01", to: "2026-09-30" });

    expect(result.events).toHaveLength(50);
    expect(result.hasMore).toBe(true);
    expect(ch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ limit: 51 }));
  });

  it("reports no more pages when the row past the limit is absent", async () => {
    const ch = fakeExecutor([
      {
        event_id: "e1",
        branch_id: "b1",
        machine_id: "m1",
        machine_code: "M-1",
        occurred_at: "2026-09-30 10:00:00",
        kind: "state",
        phase: null
      }
    ]);

    const result = await queryEvents(ch, { from: "2026-09-01", to: "2026-09-30", limit: 50 });

    expect(result.events).toHaveLength(1);
    expect(result.hasMore).toBe(false);
  });

  it("decodes a cursor into the boundary pair it will page from", async () => {
    const cursor = encodeEventCursor({ occurredAt: "2026-09-30 10:00:00", eventId: "evt-9" });

    expect(parseEventCursor(cursor)).toEqual({ occurredAt: "2026-09-30 10:00:00", eventId: "evt-9" });

    const ch = fakeExecutor([]);
    await queryEvents(ch, { from: "2026-09-01", to: "2026-09-30", cursor });
    expect(ch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cursorOccurredAt: "2026-09-30 10:00:00", cursorEventId: "evt-9" })
    );
  });

  it("leaves the cursor predicate inert when no cursor was given", async () => {
    // Empty strings make the ({cursorOccurredAt} = '' OR …) half of the
    // predicate true, so page one is not silently filtered by a blank boundary.
    const ch = fakeExecutor([]);
    await queryEvents(ch, { from: "2026-09-01", to: "2026-09-30" });

    expect(ch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cursorOccurredAt: "", cursorEventId: "" })
    );
  });

  it("round-trips an opaque event id that contains the separator itself", () => {
    // occurredAt is a timestamp and cannot contain "|"; eventId is an opaque
    // source string and can. Splitting on the last separator instead would cut
    // this id to "7" and page from a boundary that never existed.
    const cursor = encodeEventCursor({ occurredAt: "2026-09-30 10:00:00", eventId: "ns|part|7" });

    expect(parseEventCursor(cursor)).toEqual({ occurredAt: "2026-09-30 10:00:00", eventId: "ns|part|7" });
  });

  it("refuses a cursor it cannot read rather than paging from a made-up boundary", () => {
    expect(() => parseEventCursor("not-a-cursor")).toThrow("INVALID_CURSOR");
    expect(() => parseEventCursor(Buffer.from("|leading", "utf8").toString("base64url"))).toThrow("INVALID_CURSOR");
  });
});
