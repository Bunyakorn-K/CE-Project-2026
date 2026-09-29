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
  type StatusColumn,
  type StatusCount,
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
    for (const pair of ["status = 'paid'", "status = 'finished'"]) {
      expect(sql).toContain(pair);
    }
    // No bare integer comparison between the two enum columns anywhere.
    expect(sql).not.toMatch(/status\s*!=\s*status_new/);
  });

  it("never reads the new column before it is backfilled", () => {
    // The shipped WHERE was `toString(status) != toString(status_new)`, which
    // reads the column the UPDATE is about to write. The ADD COLUMN carries no
    // DEFAULT, so the value ClickHouse materialises for pre-existing rows is
    // the type's implicit default: on 26.3.34.136 `pending_payment`, on other
    // builds the out-of-range 0, which `toString` refuses with
    // UNKNOWN_ELEMENT_OF_ENUM (Code 691). Correctness therefore rested on an
    // undocumented server default. The WHERE must be unconditional so the
    // materialised value cannot matter.
    const where = sql.slice(sql.indexOf("WHERE"));
    expect(where).not.toContain("status_new");
    expect(where).toMatch(/WHERE\s+1\s*=\s*1/i);
  });

  it("keeps the new column free of a DEFAULT, so no permanent default lands on status", () => {
    // An explicit DEFAULT would guarantee a readable materialised value, but it
    // is a column property: it survives the rename onto `status`, `DESCRIBE`
    // reports it (verified on 26.3.34.136), and a future INSERT that omitted
    // `status` would then silently record `pending_payment`. The unconditional
    // WHERE removes the need for it.
    expect(buildAddColumnSQL("fact_machine_usage")).not.toMatch(/DEFAULT/i);
  });

  it("waits for the mutation to finish before anything verifies it", () => {
    expect(sql.replace(/\s+/g, " ")).toContain("mutations_sync = 2");
  });
});

describe("buildStatusCountsSQL", () => {
  it("reads the column it is given, and requires one to be named", () => {
    expect(buildStatusCountsSQL("fact_machine_usage", "status")).toContain("toString(status)");
    expect(buildStatusCountsSQL("fact_machine_usage", "status_new")).toContain("toString(status_new)");
    // Signature is `(table, column)`: there is no default, so a caller cannot
    // accidentally get the source column by omitting the argument.
    expect(buildStatusCountsSQL).toHaveLength(2);
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

  /**
   * Routes by the SQL, not by call order. A positional mock is a trap here:
   * two DDL statements sit between the source read and the pre-swap gate read,
   * so a queue built for the old call sequence silently hands the gate the
   * wrong rows. Returning `[]` for DDL and a per-column distribution for the
   * GROUP BY reads keeps each assertion about one thing.
   */
  function executorByColumn(options: {
    type?: string;
    source?: StatusCount[];
    backfilled?: StatusCount[];
  }) {
    const source = options.source ?? counts;
    return vi.fn(async (sql: string) => {
      if (/^\s*SELECT\s+type/i.test(sql)) return [{ type: options.type ?? OLD_STATUS_ENUM }];
      const column = /toString\((\w+)\)/.exec(sql)?.[1];
      if (column === "status") return source;
      if (column === "status_new") return options.backfilled ?? source;
      return []; // DDL
    });
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

  it("reads the BACKFILLED column when verifying before the swap, not the source column", async () => {
    // The defect this pins. The pre-swap gate used to call the same builder as
    // the pre-flight read, which hardcoded `status` — so between the two calls
    // the only statements were `ADD COLUMN status_new` and an `UPDATE` that
    // writes `status_new`. The gate therefore compared the untouched source
    // column against itself: it could not have detected a failed, partial,
    // mis-mapped or empty backfill, and it passed for any backfill whatsoever,
    // while the irreversibility sat ahead of it. Asserting only that the swap
    // was not attempted — as the test above does — cannot catch that, because
    // the abort plumbing works either way.
    const executor = executorByColumn({});
    await runStatusEnumMigration(executor as unknown as ClickHouseExecutor, { apply: true });

    const reads = executor.mock.calls
      .map((call) => String(call[0]))
      .filter((sql) => /\bFROM\b/i.test(sql) && /GROUP BY/i.test(sql));
    expect(reads).toHaveLength(3); // pre-flight, pre-swap, post-swap

    // Pre-flight reads the source; the old column still holds the old numbering.
    expect(reads[0]).toContain("toString(status)");
    expect(reads[0]).not.toContain("status_new");

    // The pre-swap gate must read the column the backfill wrote.
    expect(reads[1]).toContain("toString(status_new)");

    // After the rename, `status` IS the backfilled column. Stated explicitly at
    // the call site rather than left to be an accident of the rename order.
    expect(reads[2]).toContain("toString(status)");
    expect(reads[2]).not.toContain("status_new");

    // And the gate runs before the rename: reading the backfilled column is
    // only possible while it is still called `status_new`.
    const renameIndex = executor.mock.calls.findIndex((call) => /RENAME COLUMN/i.test(String(call[0])));
    const gateIndex = executor.mock.calls.findIndex((call) => String(call[0]) === reads[1]);
    expect(renameIndex).toBeGreaterThan(gateIndex);
  });

  it("would fail a backfill that silently missed a row", async () => {
    // A real gate, not a tautology. Same wiring as above, but the backfilled
    // column is missing a status the source has. While the verification was
    // reading the source column this compared the source to itself and
    // reported success — and the migration would then rename a wrong column
    // onto `status` and drop the only copy of the data.
    const executor = executorByColumn({ backfilled: [{ status: "finished", rows: "4" }] });

    const result = await runStatusEnumMigration(executor as unknown as ClickHouseExecutor, { apply: true });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("cancelled");
    expect(result.reason).toContain("status_new");
    const issued = executor.mock.calls.map((call) => String(call[0]).toUpperCase());
    expect(issued.some((sql) => sql.includes("RENAME COLUMN"))).toBe(false);
    expect(issued.some((sql) => sql.includes("DROP COLUMN"))).toBe(false);
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
