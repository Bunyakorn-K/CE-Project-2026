import { describe, expect, it, vi } from "vitest";
import {
  buildAddColumnSQL,
  buildBackfillSQL,
  buildDropOldColumnSQL,
  buildStatusCountsSQL,
  buildStatusTypeSQL,
  buildSwapColumnsSQL,
  checkEnumType,
  compareDistributions,
  formatMigrationResult,
  MIGRATION_STEPS,
  NEW_STATUS_ENUM,
  OLD_STATUS_ENUM,
  parseArgs,
  runStatusEnumMigration,
  UNDO_WARNING
} from "./migrate-usage-status-enum";
import type { ClickHouseExecutor } from "../src/analytics/clickhouse";

/**
 * `status` is renumbered from the historical declaration to the IRIS lifecycle
 * order. The migration exists because `ALTER TABLE ... MODIFY COLUMN` is the
 * wrong tool and is asserted against here, not merely avoided in a comment.
 */
describe("status enum renumbering — what the migration must not do", () => {
  it("never uses MODIFY COLUMN, which reinterprets rather than converts", () => {
    for (const build of [buildAddColumnSQL, buildBackfillSQL, buildSwapColumnsSQL, buildDropOldColumnSQL]) {
      expect(build("fact_machine_usage").toUpperCase()).not.toContain("MODIFY COLUMN");
    }
  });

  it("adds the corrected column, backfills it, swaps, then drops the old one", () => {
    expect(MIGRATION_STEPS).toEqual([
      "preflight",
      "add-column",
      "backfill",
      "verify-backfill",
      "swap",
      "drop-old",
      "verify-final"
    ]);
  });
});

describe("checkEnumType", () => {
  it("accepts exactly the pre-migration numbering", () => {
    expect(checkEnumType(OLD_STATUS_ENUM).ok).toBe(true);
  });

  it("refuses an already-migrated column, so a re-run cannot double-convert", () => {
    const result = checkEnumType(NEW_STATUS_ENUM);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("already carries");
  });

  it("refuses anything it does not recognise", () => {
    const result = checkEnumType("String");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("expected");
  });

  it("refuses an empty type rather than treating it as absent-and-therefore-fine", () => {
    expect(checkEnumType("").ok).toBe(false);
  });
});

describe("backfill mapping", () => {
  const sql = buildBackfillSQL("fact_machine_usage");

  it("maps all six old values explicitly", () => {
    // Collapse the source alignment so this asserts the mapping, not the layout.
    const flat = sql.replace(/\s+/g, " ");
    for (const value of ["pending_payment", "paid", "running", "finished", "cancelled", "admitted"]) {
      expect(flat).toContain(`status = '${value}', '${value}'`);
    }
  });

  it("has a hard-fail branch rather than a fallback value", () => {
    // The sentinel is not a fallback: it is a string the target enum cannot
    // hold, so the CAST raises UNKNOWN_ELEMENT_OF_ENUM and the whole mutation
    // fails. An unmapped row must stop the migration, not become something.
    expect(sql).toContain("__unmapped__");
    expect(sql).toContain(NEW_STATUS_ENUM);
    expect(sql).not.toMatch(/ELSE\s/i);
  });

  it("compares by name, not by number, so it is correct under either numbering", () => {
    expect(sql).toContain("toString(status) != toString(status_new)");
    expect(sql).not.toMatch(/status\s*!=\s*status_new/);
  });

  it("waits for the mutation to finish before anything verifies it", () => {
    expect(sql.replace(/\s+/g, " ")).toContain("mutations_sync = 2");
  });
});

describe("compareDistributions", () => {
  const before = [
    { status: "finished", rows: "3648" },
    { status: "cancelled", rows: "239" },
    { status: "pending_payment", rows: "0" }
  ];

  it("accepts a distribution that is identical by name", () => {
    const after = before.map((row) => ({ ...row }));
    expect(compareDistributions(before, after).ok).toBe(true);
  });

  it("rejects a lost row", () => {
    const after = [{ status: "finished", rows: "3647" }, { status: "cancelled", rows: "239" }];
    const result = compareDistributions(before, after);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("finished");
  });

  it("rejects a gained row", () => {
    const after = [...before, { status: "running", rows: "1" }];
    expect(compareDistributions(before, after).ok).toBe(false);
  });

  it("rejects a renamed status even when the count is unchanged", () => {
    const after = [
      { status: "running", rows: "3648" },
      { status: "cancelled", rows: "239" },
      { status: "pending_payment", rows: "0" }
    ];
    expect(compareDistributions(before, after).ok).toBe(false);
  });
});

describe("runStatusEnumMigration", () => {
  const counts = [
    { status: "finished", rows: "4" },
    { status: "cancelled", rows: "2" }
  ];

  function executorReturning(type: string) {
    return vi
      .fn()
      .mockResolvedValueOnce([{ type }]) // status type
      .mockResolvedValueOnce(counts) // pre-flight counts
      .mockResolvedValue(counts); // post counts
  }

  it("writes nothing unless --apply is passed", async () => {
    const executor = executorReturning(OLD_STATUS_ENUM);

    const result = await runStatusEnumMigration(executor as unknown as ClickHouseExecutor, {});

    expect(result.applied).toBe(false);
    expect(result.verified).toBe(false);
    // Type + counts only.
    expect(executor).toHaveBeenCalledTimes(2);
    for (const call of executor.mock.calls) {
      expect(String(call[0]).toUpperCase()).not.toMatch(/\b(ALTER|INSERT|DELETE|CREATE|DROP|RENAME)\b/);
    }
  });

  it("refuses before touching anything when the enum is not the expected one", async () => {
    const executor = executorReturning("String");

    const result = await runStatusEnumMigration(executor as unknown as ClickHouseExecutor, { apply: true });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("expected");
    // Only the type probe may have run.
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("refuses an already-migrated table rather than converting twice", async () => {
    const executor = executorReturning(NEW_STATUS_ENUM);

    const result = await runStatusEnumMigration(executor as unknown as ClickHouseExecutor, { apply: true });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("already carries");
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("stops before the swap when the backfilled distribution does not match", async () => {
    const executor = vi
      .fn()
      .mockResolvedValueOnce([{ type: OLD_STATUS_ENUM }])
      .mockResolvedValueOnce(counts)
      .mockResolvedValueOnce([]) // backfill verification: nothing at all
      .mockResolvedValue([]);

    const result = await runStatusEnumMigration(executor as unknown as ClickHouseExecutor, { apply: true });

    expect(result.ok).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("distribution");
    // The swap must never have been attempted.
    const issued = executor.mock.calls.map((call) => String(call[0]).toUpperCase());
    expect(issued.some((sql) => sql.includes("RENAME COLUMN"))).toBe(false);
  });
});

describe("parseArgs", () => {
  it("is read-only unless --apply is given", () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(["--apply"]).apply).toBe(true);
  });

  it("accepts a table override so the migration can be rehearsed on a scratch table", () => {
    expect(parseArgs(["--table=lt_scratch.usage_copy"]).table).toBe("lt_scratch.usage_copy");
    expect(parseArgs([]).table).toBe("fact_machine_usage");
  });
});

describe("reporting", () => {
  it("always states that the change cannot be undone without a backup", () => {
    expect(UNDO_WARNING).toMatch(/cannot be undone/i);
    // The warning must name the concrete backup, not just gesture at one.
    expect(UNDO_WARNING).toContain("_status_backup AS SELECT * FROM");
    expect(UNDO_WARNING).toContain("SELECT status, count()");
  });

  it("says the pre-flight-only run changed nothing", () => {
    const output = formatMigrationResult({
      ok: true,
      applied: false,
      verified: false,
      statusType: OLD_STATUS_ENUM,
      before: [{ status: "finished", rows: "4" }],
      after: [],
      reason: ""
    });

    expect(output).toContain("DRY RUN");
    expect(output).toContain("no statement was executed");
    expect(output).toContain(UNDO_WARNING);
  });
});
