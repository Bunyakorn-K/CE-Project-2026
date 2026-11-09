#!/usr/bin/env node
// One command that builds `fact_ml_features` and prints its own size.
//
//   pnpm --filter @laundrytwin/etl ml:features            # full history
//   pnpm --filter @laundrytwin/etl ml:features 2026-10-01 2026-11-09
//
// WHY A COMMAND AND NOT A DAG. The plan asks for a dataset that can be
// *re-derived* rather than trusted, and a scheduled writer is one more thing
// that can silently stop. This prints the row count, the distinct days and the
// number of NULL-cycle rows it produced, so the dataset states its own shape.
//
// The window defaults to the whole usage history: from the earliest business day
// on record to the end of today. Credentials come from the environment the ETL
// already uses (CLICKHOUSE_*), and nothing is printed from them.

import { ClickHouseClient } from "./clickhouse";
import { buildMlFeatures } from "./ml-features";

function dayStart(date: string): string {
  return `${date} 00:00:00`;
}

function nextDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return `${parsed.toISOString().slice(0, 10)} 00:00:00`;
}

async function main(): Promise<void> {
  const client = new ClickHouseClient();
  const [fromArg, toArg] = process.argv.slice(2);

  let from = fromArg ? dayStart(fromArg) : null;
  let to = toArg ? nextDay(toArg) : null;

  if (!from || !to) {
    const [bounds] = await client.query<{ first_day: string; last_day: string }>(
      "SELECT toString(min(toDate(started_at))) AS first_day, toString(max(toDate(started_at))) AS last_day FROM fact_machine_usage FINAL WHERE started_at IS NOT NULL"
    );
    from = from ?? dayStart(bounds.first_day);
    to = to ?? nextDay(bounds.last_day);
  }

  const report = await buildMlFeatures(client, { from, to });
  console.log(
    JSON.stringify(
      {
        table: "fact_ml_features",
        window: report.window,
        rows: report.totalRows,
        distinct_days: report.distinctDays,
        distinct_machines: report.distinctMachines,
        rows_with_null_cycles: report.rowsWithNullCycles,
        usage_rows_without_started_at_in_window: report.usageRowsWithoutStartedAt
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("ml:features failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
