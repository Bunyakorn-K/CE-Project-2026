#!/usr/bin/env node
// Renumber fact_machine_usage.status from the historical declaration to the
// real IRIS lifecycle order. WRITE MIGRATION — read-only unless --apply.
//
//   old:  pending_payment=1  paid=2  running=3     finished=4  cancelled=5  admitted=6
//   new:  pending_payment=1  paid=2  admitted=3   running=4   finished=5  cancelled=6
//
// The old numbering put `admitted` last, so "has the machine started?" was
// `status >= 6` and no range or ordering comparison over the column meant what
// a reader would assume. The new order is the upstream lifecycle, read off
// Meepain-group/iris-project @ 813ffa7: migration 0053:28-30 constrains the
// lifecycle projector to desired_status IN ('running','finished');
// active-machine-usage.ts:22-33 counts paid/running as in-progress and
// admitted/pending_payment as occupancy-only; cron.ts:2202 sweeps
// pending_payment -> cancelled; 0053:41-44 makes last_phase='IDLE' a hard
// CHECK for finished. So:
//
//   pending_payment -> paid -> admitted -> running -> finished
//                                           \-> cancelled
//
// WHY NOT `ALTER TABLE ... MODIFY COLUMN status Enum8(...)`
//
// That statement does not convert data; it reinterprets the stored bytes under
// the new definition. It is also, on current ClickHouse, simply refused: the
// server rejects a renumbering whose per-element values move, with
//
//   Code: 70. DB::Exception: Enum conversion changes value for element
//   'running' from 3 to 4: ... (CANNOT_CONVERT_TYPE)
//
// verified on ClickHouse 26.3 (the deployed image, deploy/analytics/compose.yaml:137).
// On older builds the same class of change was reported to leave parts under
// inconsistent enums (ClickHouse/ClickHouse#36359, v22.1.3.7), which is worse
// than a refusal: a table that reads differently depending on which part a row
// came from. Neither outcome is acceptable for 4,458 rows of real revenue
// data, so this script never issues MODIFY COLUMN — see the test that asserts
// it.
//
// The migration is therefore a column rebuild: add the corrected column,
// backfill it by mapping every old value by NAME, verify the distribution of
// the BACKFILLED column, swap the names, drop the old column. Because the
// mapping is by name and ClickHouse compares Enum8 by value only, the backfill
// runs before the swap and is verified before the swap — if a row cannot be
// mapped the migration aborts with the old column still authoritative and no
// data lost.
//
// THE ETL MUST NOT BE RUNNING. A row written after the mutation's part
// snapshot is not rewritten, so it keeps whatever the new column held before
// the backfill, and the rename then reclassifies it silently. This was
// reproduced end to end on a scratch table: a `paid` row came out of the swap
// as `pending_payment`, with no error anywhere. Run the migration inside
// deploy/etl/hold-etl-for-warehouse-migration.sh, which stops the ETL for the
// window and always starts it again.
//
// SAFETY PROPERTIES
//   1. Read-only by default. Without --apply it issues two SELECTs and stops.
//   2. Refuses unless `status` is exactly the pre-migration Enum8. A table
//      already migrated, or one with a different shape, is not touched at all.
//   3. The mapping is exhaustive over all six values, and the final branch is
//      a sentinel (`'__unmapped__' || toString(status)`) that the target enum
//      cannot hold, so an unmapped row raises UNKNOWN_ELEMENT_OF_ENUM and fails
//      the whole mutation. There is no fallback value.
//   4. The backfill comparison is by NAME, never by number, so it is correct
//      under either numbering and cannot silently skip or double-convert. The
//      mutation's WHERE is unconditional and never reads the new column, so
//      the value ClickHouse materialises for it cannot affect the outcome.
//   5. The distribution is verified BEFORE the swap, and the verification reads
//      the backfilled column — `status_new`, not the source `status`. Reading
//      the source here would compare the untouched source against itself, pass
//      for any backfill at all, and leave the irreversibility ahead of the
//      only step that could catch a bad one. A mismatch aborts while the old
//      column is still the one named `status`, so the table is still fully
//      readable and the fix is simply to drop the extra column.
//   6. Mutations are synchronous (mutations_sync=2) so verification never
//      races the backfill.
//
// IT CANNOT BE UNDONE. The old column is dropped at the last step. There is
// no reverse mapping in this script and no undo for a DDL drop.
//
// Run:
//   CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD / CLICKHOUSE_DATABASE
//   tsx scripts/migrate-usage-status-enum.ts              # pre-flight only
//   tsx scripts/migrate-usage-status-enum.ts --apply      # performs it
//   tsx scripts/migrate-usage-status-enum.ts --table=<t>  # a scratch table
//
// The production warehouse has NOT been migrated. This script has only ever
// been executed against local scratch tables.

import { createClickHouseClient, type ClickHouseExecutor } from "../src/analytics/clickhouse";

export const OLD_STATUS_ENUM =
  "Enum8('pending_payment' = 1, 'paid' = 2, 'running' = 3, 'finished' = 4, 'cancelled' = 5, 'admitted' = 6)";
export const NEW_STATUS_ENUM =
  "Enum8('pending_payment' = 1, 'paid' = 2, 'admitted' = 3, 'running' = 4, 'finished' = 5, 'cancelled' = 6)";

/** The status name the intermediate column is given, and the name the old
 *  column is parked under once the swap happens. */
const NEW_COLUMN = "status_new";
const OLD_COLUMN = "status_old_migrated";

/** The column the source data lives in before the swap. After the swap the
 *  backfilled column is *renamed onto* this name, so `SOURCE_COLUMN` means
 *  "the old data" only until step 5. Every read states which one it wants. */
const SOURCE_COLUMN = "status";

/** The only two physical columns a status distribution can be read from. Typed
 *  as a union on purpose: a caller cannot invent a third, and a reader of this
 *  file can see at each call site whether the gate is looking at the source
 *  column or at the backfilled one. */
export type StatusColumn = typeof SOURCE_COLUMN | typeof NEW_COLUMN;

/** Every statement this script can issue, in order, for the report and the
 *  tests to agree on. `preflight` and the two `verify` stages are reads. */
export const MIGRATION_STEPS = [
  "preflight",
  "add-column",
  "backfill",
  "verify-backfill",
  "swap",
  "drop-old",
  "verify-final"
] as const;

export const UNDO_WARNING = [
  "THIS CANNOT BE UNDONE. The old column is dropped in the final step: there is no",
  "reverse mapping in this script, and a DDL drop has no undo. Before --apply, take a",
  "backup that contains, at minimum:",
  "  CREATE TABLE <table>_status_backup AS SELECT * FROM <table>   -- full rows, old enum",
  "  SELECT status, count() FROM <table> GROUP BY status            -- the distribution",
  "and keep the ClickHouse data directory snapshot. Without those, a bad migration can",
  "only be repaired by reloading from IRIS."
].join("\n");

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/**
 * Splits a possibly-qualified `db.table` into its parts, defaulting the
 * database to the connection's own. A bare name is the real table and lives in
 * the connected database; a qualified name is how a scratch rehearsal is run
 * without touching it, and `currentDatabase()` would not resolve that.
 */
export function splitTableRef(ref: string): { database: string; table: string } {
  const index = ref.lastIndexOf(".");
  if (index === -1) return { database: "currentDatabase()", table: ref };
  return { database: `'${ref.slice(0, index)}'`, table: ref.slice(index + 1) };
}

/** Reads the live column type. This is the first thing that runs, always. */
export function buildStatusTypeSQL(table: string): string {
  const { database, table: name } = splitTableRef(table);
  return `
SELECT type
FROM system.columns
WHERE database = ${database}
  AND table = '${name}'
  AND name = 'status'`;
}

/**
 * Per-status row counts for ONE NAMED PHYSICAL COLUMN. ClickHouse JSONEachRow
 * renders counts as strings.
 *
 * `column` is required, never defaulted. The pre-swap verification used to pass
 * nothing and read `status` — the source column — which made it a tautology: it
 * compared the untouched source against itself, so it could not have detected a
 * failed, partial, mis-mapped or empty backfill. Naming the column at every
 * call site is what keeps that from coming back.
 */
export function buildStatusCountsSQL(table: string, column: StatusColumn): string {
  return `
SELECT toString(${column}) AS status, count() AS rows
FROM ${table} FINAL
GROUP BY ${column}
ORDER BY status`;
}

export function buildAddColumnSQL(table: string): string {
  // No DEFAULT, deliberately. An explicit DEFAULT is the only way to guarantee
  // the new column materialises to a value the new enum can hold, but it is a
  // permanent column property: it survives the swap onto `status`, `DESCRIBE`
  // reports it, and a future INSERT that omitted `status` would then silently
  // record `pending_payment` instead of failing. See buildBackfillSQL for why
  // the column never has to be read before it is written.
  return `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${NEW_COLUMN} ${NEW_STATUS_ENUM}`;
}

/**
 * The backfill. Each of the six old values is mapped explicitly, by name, to
 * the same name under the new numbering — the names are unchanged, only their
 * integers move, which is exactly why this cannot be done by a bare re-cast.
 *
 * The trailing branch is NOT a default. It builds a string the target enum has
 * no element for, so the CAST raises UNKNOWN_ELEMENT_OF_ENUM and the mutation
 * is rejected as a whole: a row that matches none of the six stops the
 * migration instead of being assigned a plausible-looking value.
 *
 * THE WHERE IS UNCONDITIONAL, and that is the point. It used to be
 * `toString(status) != toString(${NEW_COLUMN})` — a name comparison that reads
 * the new column before the new column has been backfilled. That is unsafe for
 * two separate reasons, both observed on ClickHouse 26.3:
 *
 *   1. The ADD COLUMN has no DEFAULT, so the value ClickHouse materialises for
 *      pre-existing rows is the type's implicit default, not a name we chose.
 *      On 26.3.34.136 that is `pending_payment` (the first element). The
 *      predicate therefore depends on an undocumented server default: on a
 *      build that materialises the out-of-range value 0, `toString()` raises
 *      `Code: 691 UNKNOWN_ELEMENT_OF_ENUM` and the whole mutation is refused.
 *      `CAST(0 AS Enum8(...))` raises 691 on this build too, and
 *      `ADD COLUMN ... Enum8(...) DEFAULT 0` is rejected outright, so the
 *      DEFAULT-less path is the only way into that state.
 *   2. A row inserted after the mutation's part snapshot is never rewritten,
 *      and it is never read either, so the shipped code does not notice: the
 *      row keeps the materialised value and the rename silently reclassifies
 *      it. Reproduced end to end on a scratch table — a `paid` row came out of
 *      the swap as `pending_payment`, dropping one cycle out of
 *      `status IN ('paid','finished')` with no error anywhere.
 *
 * An unconditional WHERE fixes (1) by construction: the un-backfilled column is
 * never read, so the materialised default is irrelevant, and it fixes the
 * silent part of (2) by making the sentinel reachable for EVERY row on EVERY
 * run instead of only for rows that happen to differ from the default.
 * (2)'s remaining exposure is a row the mutation never sees, which is why the
 * add->backfill->verify->swap window must be closed against the ETL — see
 * deploy/etl/hold-etl-for-warehouse-migration.sh.
 *
 * An unconditional UPDATE is also idempotent: the expression is a pure function
 * of `status`, so re-running it rewrites the same values. It rewrites the
 * `pending_payment` rows too, which the old predicate skipped. That is a few
 * extra bytes on a 5k-row table and it costs correctness nothing.
 */
export function buildBackfillSQL(table: string): string {
  return `ALTER TABLE ${table} UPDATE ${NEW_COLUMN} = CAST(
  multiIf(
    status = 'pending_payment', 'pending_payment',
    status = 'paid',           'paid',
    status = 'running',        'running',
    status = 'finished',       'finished',
    status = 'cancelled',      'cancelled',
    status = 'admitted',       'admitted',
    concat('__unmapped__', toString(status))
  ) AS ${NEW_STATUS_ENUM})
WHERE 1 = 1
SETTINGS mutations_sync = 2`;
}

/** One statement, so the table is never briefly without a `status` column. */
export function buildSwapColumnsSQL(table: string): string {
  return `ALTER TABLE ${table} RENAME COLUMN status TO ${OLD_COLUMN}, RENAME COLUMN ${NEW_COLUMN} TO status`;
}

export function buildDropOldColumnSQL(table: string): string {
  return `ALTER TABLE ${table} DROP COLUMN ${OLD_COLUMN}`;
}

// ---------------------------------------------------------------------------
// Pure checks
// ---------------------------------------------------------------------------

export type EnumCheck = { ok: boolean; reason: string };

export function checkEnumType(liveType: string): EnumCheck {
  if (liveType === NEW_STATUS_ENUM) {
    return {
      ok: false,
      reason:
        "fact_machine_usage.status already carries the new lifecycle numbering. Refusing to run: " +
        "converting again would map each value to the name of a different stage and lose the data."
    };
  }
  if (liveType !== OLD_STATUS_ENUM) {
    return {
      ok: false,
      reason:
        `expected the pre-migration status type\n  expected: ${OLD_STATUS_ENUM}\n  live:     ${liveType || "(column not found or unreadable)"}` +
        "\nRefusing to run. This script only converts the exact pre-migration definition."
    };
  }
  return { ok: true, reason: "" };
}

export type StatusCount = { status: string; rows: number };

export type DistributionCheck = { ok: boolean; reason: string };

/** Compares two distributions by NAME. A name missing on either side, or a
 *  changed count, fails — including the case where the same count appears
 *  under a different name, which is what a mis-numbering looks like. */
export function compareDistributions(before: StatusCount[], after: StatusCount[]): DistributionCheck {
  const asMap = (rows: StatusCount[]) => new Map(rows.map((row) => [row.status, row.rows]));
  const beforeMap = asMap(before);
  const afterMap = asMap(after);

  for (const [status, rows] of beforeMap) {
    if (!afterMap.has(status)) {
      return { ok: false, reason: `status '${status}' (${rows} rows) is missing from the backfilled column` };
    }
    if (afterMap.get(status) !== rows) {
      return {
        ok: false,
        reason: `status '${status}' had ${rows} rows before the backfill and ${afterMap.get(status)} after`
      };
    }
  }
  for (const [status, rows] of afterMap) {
    if (!beforeMap.has(status)) {
      return { ok: false, reason: `status '${status}' (${rows} rows) appears in the backfilled column but not in the source` };
    }
  }
  return { ok: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type MigrationResult = {
  ok: boolean;
  applied: boolean;
  verified: boolean;
  statusType: string;
  before: StatusCount[];
  after: StatusCount[];
  reason: string;
};

function toCounts(rows: Array<Record<string, unknown>>): StatusCount[] {
  return rows.map((row) => ({ status: String(row.status), rows: Number(row.rows) }));
}

export type MigrationOptions = { apply?: boolean; table?: string };

export async function runStatusEnumMigration(
  executor: ClickHouseExecutor,
  options: MigrationOptions = {}
): Promise<MigrationResult> {
  const table = options.table ?? "fact_machine_usage";
  const apply = options.apply === true;

  // 1. The type gate. Nothing else is issued until this passes, and it is the
  //    reason a non-migrated, an already-migrated, or an unknown table is safe
  //    to point this script at.
  const typeRows = await executor<Record<string, unknown>>(buildStatusTypeSQL(table));
  const statusType = String(typeRows[0]?.type ?? "");
  const check = checkEnumType(statusType);
  if (!check.ok) {
    return { ok: false, applied: false, verified: false, statusType, before: [], after: [], reason: check.reason };
  }

  // 2. The distribution we must reproduce. Read from the SOURCE column: at
  //    this point `status` still holds the old numbering.
  const before = toCounts(await executor<Record<string, unknown>>(buildStatusCountsSQL(table, SOURCE_COLUMN)));

  if (!apply) {
    return { ok: true, applied: false, verified: false, statusType, before, after: [], reason: "" };
  }

  // 3. Add, then backfill. The old column is untouched throughout, so any
  //    failure before the swap leaves the table fully readable.
  await executor(buildAddColumnSQL(table));
  await executor(buildBackfillSQL(table));

  // 4. Verify BEFORE the swap, reading the BACKFILLED column. This is the
  //    property that makes the migration recoverable: on a mismatch the column
  //    named `status` is still the old, correct one, and the fix is to drop the
  //    extra column.
  //
  //    This read used to name `status`, i.e. the untouched source column, so it
  //    compared the source against itself: it passed for ANY backfill whatever
  //    happened, including none. Reading `status_new` is the whole difference
  //    between a gate and a no-op, and it is the step that catches a row the
  //    mutation never saw — before the rename, not after the drop.
  const backfilled = toCounts(await executor<Record<string, unknown>>(buildStatusCountsSQL(table, NEW_COLUMN)));
  const backfillCheck = compareDistributions(before, backfilled);
  if (!backfillCheck.ok) {
    return {
      ok: false,
      applied: true,
      verified: false,
      statusType,
      before,
      after: backfilled,
      reason:
        `backfilled distribution does not match the source: ${backfillCheck.reason}. ` +
        `The swap was NOT run, so '${table}'.status still holds the original values. ` +
        `Inspect the ${NEW_COLUMN} column, then drop it to return to the pre-migration state.`
    };
  }

  // 5. Swap, then drop the old column. Past this point there is no undo.
  await executor(buildSwapColumnsSQL(table));
  await executor(buildDropOldColumnSQL(table));

  // 6. Verify the end state: the type moved, and the rows did not. This read
  //    names `status` again, but it means the BACKFILLED column: step 5 renamed
  //    `status_new` onto `status`. It worked by accident before, when the
  //    column was hardcoded; the call site now says so instead of implying it.
  const finalRows = await executor<Record<string, unknown>>(buildStatusTypeSQL(table));
  const finalType = String(finalRows[0]?.type ?? "");
  const after = toCounts(await executor<Record<string, unknown>>(buildStatusCountsSQL(table, SOURCE_COLUMN)));
  const finalCheck = compareDistributions(before, after);
  if (finalType !== NEW_STATUS_ENUM) {
    return {
      ok: false,
      applied: true,
      verified: false,
      statusType: finalType,
      before,
      after,
      reason: `after the swap, status is declared as:\n  ${finalType}\n  expected:\n  ${NEW_STATUS_ENUM}`
    };
  }
  if (!finalCheck.ok) {
    return {
      ok: false,
      applied: true,
      verified: false,
      statusType: finalType,
      before,
      after,
      reason: `after the swap the distribution changed: ${finalCheck.reason}`
    };
  }

  return { ok: true, applied: true, verified: true, statusType: finalType, before, after, reason: "" };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function table(rows: StatusCount[]): string[] {
  if (rows.length === 0) return ["  (none)"];
  const width = Math.max(...rows.map((row) => row.status.length));
  return rows.map((row) => `  ${row.status.padEnd(width)}  ${String(row.rows).padStart(8)}`);
}

export function formatMigrationResult(result: MigrationResult, options: { table?: string } = {}): string {
  const lines: string[] = [];
  lines.push(`LaundryTwin status enum renumbering — table ${options.table ?? "fact_machine_usage"}`);
  lines.push("");
  lines.push(`  old: ${OLD_STATUS_ENUM}`);
  lines.push(`  new: ${NEW_STATUS_ENUM}`);
  lines.push("  order: pending_payment -> paid -> admitted -> running -> finished ( + cancelled )");
  lines.push("");

  if (result.statusType) {
    lines.push(`Live status type: ${result.statusType}`);
  } else {
    lines.push("Live status type: (unavailable)");
  }
  lines.push("");

  if (!result.ok) {
    lines.push("RESULT: REFUSED — nothing was migrated.");
    lines.push(result.reason);
    return lines.join("\n");
  }

  if (!result.applied) {
    lines.push("RESULT: DRY RUN — no statement was executed, nothing was written.");
    lines.push("Re-run with --apply to perform the migration.");
    lines.push("");
    lines.push("Current distribution:");
    lines.push(...table(result.before));
    lines.push("");
    lines.push(UNDO_WARNING);
    return lines.join("\n");
  }

  lines.push("Distribution before:");
  lines.push(...table(result.before));
  lines.push("");
  lines.push("Distribution after:");
  lines.push(...table(result.after));
  lines.push("");
  lines.push(
    result.verified
      ? "RESULT: MIGRATED AND VERIFIED — same statuses, same row counts, new numbering."
      : "RESULT: MIGRATION INCOMPLETE — see the reason above."
  );
  lines.push("");
  lines.push(UNDO_WARNING);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): { apply: boolean; table: string } {
  const options = { apply: false, table: "fact_machine_usage" };
  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    const [flag, value] = arg.split("=", 2);
    if (flag === "--table" && value) options.table = value;
  }
  return options;
}

const invokedDirectly = process.argv[1]?.endsWith("migrate-usage-status-enum.ts");
if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  runStatusEnumMigration(createClickHouseClient(), options)
    .then((result) => {
      console.log(formatMigrationResult(result, { table: options.table }));
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
