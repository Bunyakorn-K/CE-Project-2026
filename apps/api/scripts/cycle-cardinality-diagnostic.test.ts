import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildBranchSessionNullRateSQL,
  buildCycleDefinitionSQL,
  buildMultiStatusSessionExamplesSQL,
  buildMultiStatusSessionSQL,
  buildRowCountSQL,
  buildSessionNullRateSQL,
  buildSessionSpanByStatusSQL,
  buildSessionSpanHistogramSQL,
  buildSessionSpanSummarySQL,
  buildStatusDistributionSQL,
  buildEnumTypeSQL,
  CYCLE_DEFINITIONS,
  ENUM_VERSION_REFUSAL_REASON,
  enumVersionOf,
  formatDiagnostic,
  parseArgs,
  POST_MIGRATION_STATUS_TYPE,
  PRE_MIGRATION_STATUS_TYPE,
  REFUSAL_REASON,
  runCycleCardinalityDiagnostic,
  satangPerCycle,
  shouldRefuseVerdict
} from "./cycle-cardinality-diagnostic";
import type { ClickHouseExecutor } from "../src/analytics/clickhouse";
import { buildDashboardSQL, buildMachineStateSQL } from "../src/report/clickhouse-report";

const SQL_BUILDERS = [
  buildRowCountSQL,
  buildSessionSpanSummarySQL,
  buildSessionSpanHistogramSQL,
  buildMultiStatusSessionSQL,
  buildMultiStatusSessionExamplesSQL,
  buildStatusDistributionSQL,
  buildSessionNullRateSQL,
  buildBranchSessionNullRateSQL,
  buildSessionSpanByStatusSQL,
  buildCycleDefinitionSQL
];

// Column set mirrored from apps/etl/src/schema.ts:69-90. The diagnostic is
// read-only so a rename cannot corrupt anything, but it would silently return
// zeros or a ClickHouse error, and zeros are exactly what this script is asked
// to distinguish from "no data". Keep this list in step with the schema.
const USAGE_COLUMNS = [
  "tenant_id",
  "branch_id",
  "machine_id",
  "usage_id",
  "source_event_id",
  "machine_session_id",
  "started_at",
  "finished_at",
  "duration_min",
  "program_id",
  "program_name",
  "temp_level",
  "amount_satang",
  "status",
  "initiated_via",
  "attribution_state",
  "attribution_source",
  "source_created_at",
  "source_updated_at",
  "extracted_at"
];

function readRepoFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");
}

/** A fake ClickHouse that answers from a map of query-fragment -> rows. */
function fakeExecutor(
  responder: (query: string, callIndex: number) => Array<Record<string, unknown>>
): { executor: ClickHouseExecutor; queries: string[] } {
  const queries: string[] = [];
  const executor: ClickHouseExecutor = async <T extends Record<string, unknown>>(query: string) => {
    queries.push(query);
    return responder(query, queries.length - 1) as T[];
  };
  return { executor, queries };
}

const ALL_REAL_ROW_COUNTS = [
  { total_rows: "1000", synthetic_rows: "0", real_rows: "1000", first_real_row: "2026-01-01 00:00:00.000", last_real_row: "2026-09-01 00:00:00.000" }
];

describe("cycle-cardinality-diagnostic SQL", () => {
  it("issues read-only statements only", () => {
    for (const build of SQL_BUILDERS) {
      const sql = build();
      expect(sql).not.toMatch(/\b(INSERT|ALTER|DELETE|CREATE|DROP|TRUNCATE|RENAME|ATTACH|DETACH|OPTIMIZE|GRANT|REVOKE|KILL)\b/i);
      expect(sql).not.toMatch(/FORMAT\s+JSONEachRow/);
    }
  });

  it("reads only the two tables the diagnostic documents", () => {
    for (const build of SQL_BUILDERS) {
      const tables = [...build().matchAll(/\b(FROM|JOIN)\s+([a-z_]+)/gi)].map((match) => match[2]);
      for (const table of tables) {
        expect(["fact_machine_usage", "dim_branch"]).toContain(table);
      }
    }
  });

  it("filters every measurement to non-synthetic rows", () => {
    for (const build of SQL_BUILDERS) {
      expect(build()).toContain("NOT startsWith(");
    }
    // The row-count probe is the exception that proves the guard works: it has
    // to be able to see the synthetic rows in order to refuse. It applies the
    // predicate with countIf/minIf/maxIf rather than a WHERE clause, so the
    // refusal can report the table it is declining to describe.
    const counts = buildRowCountSQL();
    expect(counts).not.toMatch(/\bWHERE\b/i);
    expect(counts).toContain("countIf(startsWith(source_event_id, 'synthetic:'))");
    expect(counts).toContain("minIf(started_at, NOT startsWith(source_event_id, 'synthetic:'))");
  });

  it("only references fact_machine_usage columns that exist in the ETL schema", () => {
    for (const build of SQL_BUILDERS) {
      const sql = build();
      for (const column of ["machine_session_id", "source_event_id", "started_at", "branch_id", "status"]) {
        if (sql.includes(column)) expect(USAGE_COLUMNS).toContain(column);
      }
      if (sql.includes("amount_satang")) expect(USAGE_COLUMNS).toContain("amount_satang");
      if (sql.includes("duration_min")) expect(USAGE_COLUMNS).toContain("duration_min");
    }
  });

  it("leaves the range and branch optional instead of defaulting them", () => {
    for (const build of SQL_BUILDERS.slice(1)) {
      const sql = build();
      expect(sql).toContain("{from:String} = ''");
      expect(sql).toContain("{to:String} = ''");
      expect(sql).toContain("{branchId:String} = ''");
    }
  });

  // `CYCLE_DEFINITIONS` is now a frozen record of the four candidate
  // expressions that were compared against the real warehouse on 2026-09-29,
  // not a live mirror of the code. Two of the four surfaces have since adopted
  // the row-count definition, so "the script quotes the current code" stopped
  // being true for them — and it must stay false, because rewriting them to
  // match today's code would delete the ฿125.42-vs-฿42.20 finding that
  // decided the question. The two surfaces that were not part of the decision
  // are still quoted live, and the two that were are asserted to have moved.
  it("records the four candidates compared on 2026-09-29 and keeps the two unchanged ones live", () => {
    const report = readRepoFile("apps/api/src/report/clickhouse-report.ts");
    const queries = readRepoFile("apps/api/src/analytics/queries.ts");

    // Still quoted from the code that renders them.
    expect(queries).toContain("countIf(status IN ('finished','paid')) AS cycles");
    expect(queries).toContain("count() AS cycles");

    // The two surfaces the decision moved, now on the canonical definition.
    const dashboardSql = buildDashboardSQL();
    const machineStateSql = buildMachineStateSQL();
    expect(dashboardSql).toContain("countIf(u.status IN ('paid', 'finished')) AS cycles");
    expect(machineStateSql).toContain("countIf(u.status IN ('paid', 'finished')) AS cycle_count");
    expect(dashboardSql).not.toMatch(/uniqExactIf|countDistinct\(u\.machine_session_id\)/);
    expect(machineStateSql).not.toContain("countDistinct(u.machine_session_id)");

    // The four surfaces are the whole disagreement; a fifth would be a new
    // definition nobody has scoped.
    expect(CYCLE_DEFINITIONS).toHaveLength(4);
    expect(new Set(CYCLE_DEFINITIONS.map((definition) => definition.key)).size).toBe(4);
  });
});

describe("cycle-cardinality-diagnostic enum-version guard", () => {
  // The enum probe is the one query the guard may add. It must be a plain read
  // of the catalog, and it must not name a fact table, or the guard would be
  // the first thing in this script that can touch data.
  it("probes system.columns and writes nothing", () => {
    const sql = buildEnumTypeSQL();
    expect(sql).toMatch(/FROM\s+system\.columns/i);
    expect(sql).not.toMatch(/\b(INSERT|ALTER|DELETE|CREATE|DROP|TRUNCATE|RENAME|ATTACH|DETACH|OPTIMIZE|GRANT|REVOKE|KILL)\b/i);
    expect(sql).not.toMatch(/fact_machine_usage\s*FINAL/i);
    expect(sql).toContain("'status'");
  });
  // Every candidate expression in this script is quoted against the PRE-
  // migration numbering, where `status IN (2, 4)` meant paid + finished. That
  // is deliberate — those expressions are the evidence the 2026-09-29 decision
  // rests on, and rewriting them would delete the finding. But a quoted
  // expression is only evidence while the enum still has the numbering it was
  // quoted against: after the lifecycle renumbering, `IN (2, 4)` silently means
  // `paid` + `running`. The guard makes the script refuse rather than report a
  // number computed from an expression it can no longer read the same way.
  it("accepts the pre-migration numbering and rejects the post-migration one", () => {
    expect(enumVersionOf(PRE_MIGRATION_STATUS_TYPE)).toBe("pre-migration");
    expect(enumVersionOf(POST_MIGRATION_STATUS_TYPE)).toBe("post-migration");
    expect(enumVersionOf("Enum8('paid' = 1)")).toBe("unknown");
    expect(enumVersionOf("")).toBe("unknown");
  });

  it("states what would have been measured wrongly", () => {
    expect(ENUM_VERSION_REFUSAL_REASON).toContain("status IN (2, 4)");
    expect(ENUM_VERSION_REFUSAL_REASON).toContain("paid");
    expect(ENUM_VERSION_REFUSAL_REASON).toContain("running");
  });

  it("refuses to run against a warehouse already carrying the new numbering", async () => {
    // No statusType: this drives the real probe path, which is what production
    // takes. The catalog answers with the post-migration type.
    const executor = vi.fn().mockResolvedValue([{ type: POST_MIGRATION_STATUS_TYPE }]);
    const result = await runCycleCardinalityDiagnostic(executor as unknown as ClickHouseExecutor);

    expect(result.refused).toBe(true);
    // The refusal must cost nothing: only the enum probe may have been issued,
    // so no countIf(status IN (2, 4)) can have run against the new numbering.
    expect(executor).toHaveBeenCalledTimes(1);
    if (result.refused) expect(result.reason).toBe(ENUM_VERSION_REFUSAL_REASON);
    const rendered = formatDiagnostic(result);
    expect(rendered).toContain("REFUSED");
    // It must not present "not measured" as "measured zero".
    expect(rendered).toContain("NOT measured");
    expect(rendered).not.toContain("total_rows=0");
  });

  it("refuses when the status column is not one of the two known numberings at all", async () => {
    const executor = vi.fn().mockResolvedValue([{ type: "Enum16('pending_payment' = 1)" }]);
    const result = await runCycleCardinalityDiagnostic(executor as unknown as ClickHouseExecutor);

    expect(result.refused).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
    if (result.refused) expect(result.reason).toBe(ENUM_VERSION_REFUSAL_REASON);
  });

  it("still runs against a warehouse on the numbering its quotes assume", async () => {
    const executor = vi.fn().mockResolvedValueOnce([{ type: PRE_MIGRATION_STATUS_TYPE }]).mockResolvedValueOnce([]);
    const result = await runCycleCardinalityDiagnostic(executor as unknown as ClickHouseExecutor);

    // The enum gate passes; the synthetic-row gate is the next one to fire.
    expect(executor).toHaveBeenCalledTimes(2);
    expect(result.refused).toBe(true);
    if (result.refused) expect(result.reason).toBe(REFUSAL_REASON);
  });
});

describe("cycle-cardinality-diagnostic synthetic guard", () => {
  it("refuses when there are no non-synthetic rows", () => {
    expect(shouldRefuseVerdict(0)).toBe(true);
    expect(shouldRefuseVerdict(-1)).toBe(true);
    expect(shouldRefuseVerdict(Number.NaN)).toBe(true);
  });

  it("does not refuse when real rows exist", () => {
    expect(shouldRefuseVerdict(1)).toBe(false);
    expect(shouldRefuseVerdict(1755)).toBe(false);
  });

  it("stops after the row-count probe when everything is synthetic", async () => {
    const { executor, queries } = fakeExecutor(() => [
      { total_rows: "1755", synthetic_rows: "1755", real_rows: "0", first_real_row: null, last_real_row: null }
    ]);
    const result = await runCycleCardinalityDiagnostic(executor, { statusType: PRE_MIGRATION_STATUS_TYPE });

    expect(result.refused).toBe(true);
    if (!result.refused) throw new Error("expected a refusal");
    expect(result.rowCounts.realRows).toBe(0);
    expect(result.reason).toBe(REFUSAL_REASON);
    // One query, and it is the row-count probe. No measurement can run, so no
    // seed-derived number can reach the report.
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("real_rows");
  });

  it("prints the refusal instead of a report", async () => {
    const { executor } = fakeExecutor(() => [
      { total_rows: "1755", synthetic_rows: "1755", real_rows: "0", first_real_row: null, last_real_row: null }
    ]);
    const output = formatDiagnostic(
      await runCycleCardinalityDiagnostic(executor, { statusType: PRE_MIGRATION_STATUS_TYPE })
    );

    expect(output).toContain("REFUSED");
    expect(output).toContain("total_rows=1755");
    expect(output).toContain("synthetic_rows=1755");
    expect(output).toContain("real_rows=0");
    expect(output).toContain("machine_session_id");
    // The report body must not appear at all.
    expect(output).not.toContain("Revenue (status IN (2,4))");
    expect(output).not.toContain("1. Rows per machine_session_id");
  });

  it("reports measurements when real rows exist", async () => {
    const { executor, queries } = fakeExecutor((query) => {
      if (query.includes("real_rows")) return ALL_REAL_ROW_COUNTS;
      if (query.includes("p50_rows_per_session")) {
        return [
          {
            session_ids: "3",
            min_rows_per_session: "1",
            max_rows_per_session: "4",
            avg_rows_per_session: "2.33",
            p50_rows_per_session: "2",
            p75_rows_per_session: "2",
            p90_rows_per_session: "4",
            p99_rows_per_session: "4"
          }
        ];
      }
      if (query.includes("rows_per_session,") && query.includes("GROUP BY rows_per_session")) {
        return [
          { rows_per_session: "1", session_ids: "1" },
          { rows_per_session: "2", session_ids: "1" },
          { rows_per_session: "4", session_ids: "1" }
        ];
      }
      if (query.includes("multi_revenue_status_session_ids")) {
        return [
          {
            session_ids: "3",
            multi_status_session_ids: "1",
            multi_revenue_status_session_ids: "1",
            max_distinct_statuses: "2",
            max_revenue_statuses: "2"
          }
        ];
      }
      if (query.includes("HAVING uniqExact(status) > 1")) {
        return [{ machine_session_id: "s-1", any_status: "finished", statuses: "['finished','paid']", rows: "4" }];
      }
      if (query.includes("AS status,") && query.includes("GROUP BY status\n")) {
        return [
          { status: "finished", rows: "6", distinct_session_ids: "2" },
          { status: "paid", rows: "2", distinct_session_ids: "1" }
        ];
      }
      if (query.includes("null_session_pct") && query.includes("branch_name")) {
        return [
          {
            branch_id: "b-1",
            branch_name: "Branch One",
            rows: "8",
            rows_without_session_id: "2",
            null_session_pct: "25"
          }
        ];
      }
      if (query.includes("null_session_pct")) {
        return [{ rows: "8", rows_without_session_id: "2", null_session_pct: "25", distinct_session_ids: "3" }];
      }
      if (query.includes("session_span")) {
        return [{ status: "finished", session_span: "session_multi_row", rows: "4", distinct_session_ids: "1" }];
      }
      if (query.includes("dashboard_kpi_cycles")) {
        return [
          {
            revenue_satang: "40000",
            cycles_daily_rows: "8",
            utilization_rows: "9",
            distinct_sessions_finished_or_paid: "3",
            distinct_sessions_any_status: "3",
            dashboard_kpi_cycles: "4",
            twin_tab_cycles: "3"
          }
        ];
      }
      return [];
    });

    const result = await runCycleCardinalityDiagnostic(executor, {
      from: "2026-09-01",
      to: "2026-09-28",
      statusType: PRE_MIGRATION_STATUS_TYPE
    });
    expect(result.refused).toBe(false);
    if (result.refused) throw new Error("expected measurements");
    const m = result.measurements;

    expect(queries).toHaveLength(10);
    expect(result.range).toEqual({ from: "2026-09-01", to: "2026-09-28", branchId: "" });

    // Distribution, not just an average.
    expect(m.sessionSpan.minRowsPerSession).toBe(1);
    expect(m.sessionSpan.maxRowsPerSession).toBe(4);
    expect(m.sessionSpan.p90).toBe(4);
    expect(m.sessionSpan.multiRowSessionIds).toBe(2);
    expect(m.sessionSpan.histogram).toEqual([
      { rowsPerSession: 1, sessionIds: 1 },
      { rowsPerSession: 2, sessionIds: 1 },
      { rowsPerSession: 4, sessionIds: 1 }
    ]);

    // The double-count condition, measured rather than assumed.
    expect(m.statusSpan.multiStatusSessionIds).toBe(1);
    expect(m.statusSpan.multiRevenueStatusSessionIds).toBe(1);
    expect(m.statusSpan.examples[0]?.machineSessionId).toBe("s-1");

    // Whether paid / running occur at all.
    expect(m.statusDistribution.map((row) => row.status)).toEqual(["finished", "paid"]);
    expect(m.statusDistribution.reduce((sum, row) => sum + row.rows, 0)).toBe(8);

    // A null session id would under-report every session-distinct count.
    expect(m.sessionIdCoverage.nullSessionPct).toBe(25);
    expect(m.sessionIdCoverage.perBranch[0]?.branchName).toBe("Branch One");

    // All four definitions side by side, with the price band recomputed.
    expect(m.cycleComparison.revenueSatang).toBe(40000);
    expect(m.cycleComparison.byDefinition.map((definition) => definition.cycles)).toEqual([4, 3, 8, 9]);
    expect(m.cycleComparison.byDefinition.map((definition) => definition.satangPerCycle)).toEqual([10000, 13333.33, 5000, 4444.44]);

    const output = formatDiagnostic(result);
    expect(output).toContain("1. Rows per machine_session_id");
    expect(output).toContain("4 -> 1");
    expect(output).toContain("multi_revenue_status(2,4)=1");
    expect(output).toContain("no cycle-counting behaviour was changed");
    expect(output).toContain("฿100.00/cycle");
    expect(output).toContain("฿44.44/cycle");
  });

  it("reports nan aggregates from an empty session set as unknown, not zero", async () => {
    const { executor } = fakeExecutor((query) => {
      if (query.includes("real_rows")) return ALL_REAL_ROW_COUNTS;
      if (query.includes("p50_rows_per_session")) {
        return [
          {
            session_ids: "0",
            min_rows_per_session: null,
            max_rows_per_session: null,
            avg_rows_per_session: "nan",
            p50_rows_per_session: "nan",
            p75_rows_per_session: "nan",
            p90_rows_per_session: "nan",
            p99_rows_per_session: "nan"
          }
        ];
      }
      return [];
    });
    const result = await runCycleCardinalityDiagnostic(executor, { statusType: PRE_MIGRATION_STATUS_TYPE });
    if (result.refused) throw new Error("expected measurements");

    expect(result.measurements.sessionSpan.minRowsPerSession).toBeNull();
    expect(result.measurements.sessionSpan.avgRowsPerSession).toBeNull();
    expect(formatDiagnostic(result)).toContain("min=n/a");
  });
});

describe("cycle-cardinality-diagnostic helpers", () => {
  it("divides satang per cycle and refuses a zero denominator", () => {
    expect(satangPerCycle(5_374_863, 420)).toBe(12797.29);
    expect(satangPerCycle(5_374_863, 1496)).toBe(3592.82);
    expect(satangPerCycle(1000, 0)).toBeNull();
    expect(satangPerCycle(1000, -3)).toBeNull();
  });

  it("parses optional CLI flags and ignores anything else", () => {
    expect(parseArgs(["--from=2026-09-01", "--to=2026-09-28", "--branch=abc", "--force"])).toEqual({
      from: "2026-09-01",
      to: "2026-09-28",
      branchId: "abc"
    });
    expect(parseArgs([])).toEqual({});
  });
});
