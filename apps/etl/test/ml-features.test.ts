import { describe, expect, it, vi } from "vitest";
import { CREATE_TABLES, ML_FEATURES_DDL, ML_FEATURES_TABLE, TABLE_COLUMNS } from "../src/schema.js";
import { buildMlFeatures, buildMlFeaturesInsertSQL } from "../src/ml-features.js";
import type { ClickHouseClient } from "../src/clickhouse.js";

const insertSql = buildMlFeaturesInsertSQL();

describe("fact_ml_features DDL", () => {
  it("is declared in schema.ts so the ETL's DDL pass creates it", () => {
    expect(CREATE_TABLES).toContain(ML_FEATURES_DDL);
    expect(TABLE_COLUMNS[ML_FEATURES_TABLE]).toBeDefined();
    expect(TABLE_COLUMNS[ML_FEATURES_TABLE]).toContain("cycle_count");
  });

  it("is grained per branch x machine x hour", () => {
    expect(ML_FEATURES_DDL).toContain("ORDER BY (tenant_id, branch_id, machine_id, hour)");
    expect(ML_FEATURES_DDL).toContain("hour DateTime");
    expect(ML_FEATURES_DDL).toContain("machine_id UUID");
  });

  it("declares every measurement as Nullable, because an unmeasured hour is not zero", () => {
    for (const column of [
      "cycle_count",
      "paid_count",
      "finished_count",
      "cancelled_count",
      "total_duration_min",
      "revenue_satang",
      "avg_temperature_c",
      "total_rain_mm"
    ]) {
      expect(ML_FEATURES_DDL).toMatch(new RegExp(`${column} Nullable\\(`));
    }
  });

  it("keeps machine_id and hour non-nullable, so a row cannot lose its identity", () => {
    expect(ML_FEATURES_DDL).toContain("machine_id UUID,");
    expect(ML_FEATURES_DDL).toContain("hour DateTime,");
  });
});

describe("buildMlFeaturesInsertSQL", () => {
  it("builds a spine of hours rather than grouping only observed rows", () => {
    // A GROUP BY can only emit hours that had rows, which is what silently drops
    // a source gap. The spine is what makes a missing hour representable.
    expect(insertSql).toContain("numbers(dateDiff('hour'");
    expect(insertSql).toContain("CROSS JOIN");
  });

  it("emits NULL for a day that reported no usage rows", () => {
    for (const column of ["cycle_count", "paid_count", "finished_count", "cancelled_count", "total_duration_min", "revenue_satang"]) {
      expect(insertSql).toContain(`if(coverage.rows = 0, NULL, coalesce(u.`);
      expect(insertSql).toMatch(new RegExp(`AS ${column}`));
    }
    expect(insertSql).toContain("day_coverage AS (");
  });

  it("never coalesces a measurement to 0 without the coverage guard", () => {
    // Line-based on purpose: every line that coalesces a usage aggregate must be
    // guarded by the day-coverage test, however it is wrapped (one of them goes
    // through toFloat64).
    const lines = insertSql.split("\n").filter((line) => line.includes("coalesce(u."));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain("if(coverage.rows = 0, NULL, ");
    }
  });

  it("binds its window instead of using today()", () => {
    expect(insertSql).toContain("started_at >= {from:DateTime}");
    expect(insertSql).toContain("started_at < {to:DateTime}");
    expect(insertSql).not.toContain("today()");
  });

  it("excludes usage rows with no started_at instead of placing them at the epoch", () => {
    expect(insertSql).toContain("started_at IS NOT NULL");
  });

  it("is half-open, so two adjacent windows cannot double-count a boundary hour", () => {
    expect(insertSql).not.toContain("started_at <= {to:DateTime}");
  });
});

describe("buildMlFeatures", () => {
  function fakeClient() {
    const calls: Array<{ sql: string; settings?: Record<string, string> }> = [];
    const client = {
      query: vi.fn(async (sql: string, settings?: Record<string, string>) => {
        calls.push({ sql, settings });
        if (sql.startsWith("CREATE TABLE")) return [];
        if (sql.startsWith("INSERT INTO")) return [];
        if (sql.includes("uniqExact(day)")) {
          return [{ total_rows: "52800", days: "110", machines: "20", null_cycles: "4560" }];
        }
        return [{ orphans: "631" }];
      })
    } as unknown as ClickHouseClient;
    return { client, calls };
  }

  it("creates, fills, and reports its own size", async () => {
    const { client, calls } = fakeClient();
    const report = await buildMlFeatures(client, { from: "2026-07-22 00:00:00", to: "2026-11-10 00:00:00" });

    expect(calls[0].sql).toContain("CREATE TABLE IF NOT EXISTS fact_ml_features");
    expect(calls[1].sql).toContain("INSERT INTO fact_ml_features");
    expect(calls[1].settings).toEqual({ param_from: "2026-07-22 00:00:00", param_to: "2026-11-10 00:00:00" });
    expect(report).toMatchObject({
      totalRows: 52800,
      distinctDays: 110,
      distinctMachines: 20,
      rowsWithNullCycles: 4560,
      usageRowsWithoutStartedAt: 631
    });
  });

  it("binds the window as ClickHouse named parameters, not as SQL text", async () => {
    const { client, calls } = fakeClient();
    await buildMlFeatures(client, { from: "2026-07-22 00:00:00", to: "2026-11-10 00:00:00" });
    for (const call of calls.slice(1)) {
      expect(call.settings?.param_from).toBe("2026-07-22 00:00:00");
      expect(call.settings?.param_to).toBe("2026-11-10 00:00:00");
      expect(call.sql).not.toContain("2026-07-22");
    }
  });
});
