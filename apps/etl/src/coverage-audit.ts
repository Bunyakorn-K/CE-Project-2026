// Read-only coverage audit: compares the warehouse against the IRIS source and
// classifies every day as present / recoverable / never-a-business-day / true
// gap. Writes nothing. Exits non-zero only on a genuinely recoverable gap.
//
//   PG_CONNECTION_STRING=... CLICKHOUSE_URL=... CLICKHOUSE_USER=... \
//   CLICKHOUSE_PASSWORD=... CLICKHOUSE_DATABASE=... \
//     pnpm --filter @laundrytwin/etl coverage
//
// The window defaults to the warehouse's own span rather than a fixed range, so
// the audit always examines exactly the days it is responsible for. Override
// with COVERAGE_FROM / COVERAGE_TO.
//
// See ./coverage.ts for why a count-only comparison cannot answer this.

import { createPostgresSource } from "./postgres.js";
import { ClickHouseClient } from "./clickhouse.js";
import { classifyCoverage, needsAttention, summarise } from "./coverage.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value as string;
}

function optional(name: string): string | null {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : null;
}

const connectionString = required("PG_CONNECTION_STRING");
const from = optional("COVERAGE_FROM");
const to = optional("COVERAGE_TO");

const source = createPostgresSource({ connectionString });
const warehouse = new ClickHouseClient({
  url: required("CLICKHOUSE_URL"),
  user: required("CLICKHOUSE_USER"),
  password: required("CLICKHOUSE_PASSWORD"),
  database: required("CLICKHOUSE_DATABASE")
});

try {
  // Resolve the window from the warehouse itself when the caller did not pin
  // one. Anchoring on the newest BUSINESS day rather than today() matters: a
  // young or closed day legitimately has no rows yet, and auditing it would
  // manufacture a gap out of the clock.
  const bounds = await warehouse.query<{ first_day: string; last_day: string }>(
    `SELECT toString(min(toDate(started_at))) AS first_day,
            toString(max(toDate(started_at))) AS last_day
       FROM fact_machine_usage FINAL
      WHERE started_at IS NOT NULL`
  );
  const row = bounds[0];
  if (!row?.first_day || row.first_day.startsWith("1970")) {
    console.log("fact_machine_usage has no rows carrying started_at; nothing to audit.");
    process.exit(0);
  }
  const warehouseDays = await warehouse.query<{ day: string; rows: string }>(
    `SELECT toString(toDate(started_at)) AS day, toString(count()) AS rows
       FROM fact_machine_usage FINAL
      WHERE started_at IS NOT NULL
      GROUP BY day ORDER BY day`
  );

  // The window must be a range BOTH sides can speak about. Anchoring it on the
  // warehouse alone asks the source about days that predate its oldest row, and
  // every one of those comes back "absent from source" — the same false gap this
  // audit exists to prevent, produced by the window rather than by the data.
  // So the default is the intersection of the two spans, and an explicit
  // override is clamped to it and says so.
  const sourceFirst = await source.firstUsageDay();
  if (!sourceFirst) {
    console.log("the source holds no usage rows at all; nothing to compare against.");
    process.exit(0);
  }
  const low = [row.first_day, sourceFirst].sort()[1];
  const high = row.last_day;
  const windowFrom = from && from > low ? from : low;
  const windowTo = to && to < high ? to : high;
  if ((from && from < low) || (to && to > high)) {
    console.log(
      `requested window ${from ?? "start"} .. ${to ?? "end"} exceeds the comparable span ` +
        `${low} .. ${high} (the source holds no rows before ${sourceFirst}); clamped.`
    );
  }
  if (windowFrom > windowTo) {
    console.log(`the warehouse (${row.first_day} .. ${row.last_day}) and the source ` +
      `(${sourceFirst} ..) do not overlap; nothing to compare.`);
    process.exit(0);
  }

  const [sourceDays, sourceBusinessDays] = await Promise.all([
    source.auditUsageDaysByCreatedAt(windowFrom, windowTo),
    source.auditUsageDaysByStartedAt(windowFrom, windowTo)
  ]);

  const toMap = (rows: Array<{ day: string; rows: number | string }>) =>
    Object.fromEntries(rows.map((r) => [r.day, Number(r.rows)]));

  const summary = classifyCoverage({
    from: windowFrom,
    to: windowTo,
    warehouse: toMap(warehouseDays),
    source: sourceDays,
    sourceWithBusinessTimestamp: sourceBusinessDays
  });

  console.log(
    `warehouse: ${warehouseDays.length} business days ` +
      `(${warehouseDays[0]?.day ?? "none"} .. ${warehouseDays.at(-1)?.day ?? "none"})`
  );
  console.log(
    `source:    ${Object.keys(sourceDays).length} created-days, ` +
      `${Object.keys(sourceBusinessDays).length} carrying started_at`
  );
  console.log(summarise(summary));

  if (summary.recoverable.length) {
    console.log("");
    console.log(`RECOVERABLE — the source holds these days and a reload could fill them:`);
    for (const day of summary.recoverable) {
      const d = summary.days.find((x) => x.day === day)!;
      console.log(
        `  ${day}  source_rows=${d.sourceRows} with_started_at=${d.sourceRowsWithBusinessTimestamp}`
      );
    }
  }

  if (summary.absentFromSource.length) {
    console.log("");
    console.log(`ABSENT FROM SOURCE — no rows on either side (true gaps):`);
    console.log(`  ${summary.absentFromSource.join(", ")}`);
  }

  if (summary.noBusinessTimestamp.length) {
    // Reported, never alerted on. This bucket is a property of the source
    // schema, not a fault: these are days the source has dispatch rows for
    // that never started a cycle, so the business timeline correctly omits them.
    console.log("");
    console.log(
      `NOT A BUSINESS DAY — source has rows but none carry started_at ` +
        `(${summary.noBusinessTimestamp.length} day(s), not counted as missing):`
    );
    console.log(`  ${summary.noBusinessTimestamp.slice(0, 10).join(", ")}` +
      (summary.noBusinessTimestamp.length > 10 ? ", …" : ""));
  }

  process.exitCode = needsAttention(summary) ? 1 : 0;
} finally {
  await source.close().catch(() => {});
}