// Ops verification: connects to the IRIS Postgres source and reports counts +
// timestamp bounds per dataset, walking the same incremental batches the ETL
// would use. Run passively before first real load (or after)
// to confirm the read path and row counts.
//
//   ssh -f -N -L 15432:127.0.0.1:5432 debian@172.30.186.206
//   PG_CONNECTION_STRING=postgresql://postgres@127.0.0.1:15432/iris_project \
//     pnpm --filter @laundrytwin/etl verify

import {
  createPostgresSource,
  type TemperatureSampleRow,
  type UsageRow,
} from "./postgres.js";
import type { TemperatureCursor, UsageCursor } from "./watermark.js";

const connectionString = process.env.PG_CONNECTION_STRING;
if (!connectionString) {
  console.error("PG_CONNECTION_STRING is required");
  process.exitCode = 1;
} else {
  await verify(connectionString);
}

async function verify(connectionString: string) {
  const source = createPostgresSource({ connectionString });
  try {
    const branches = await source.listBranches();
    const machines = await source.listMachines();
    console.log(`branches: ${branches.length}`);
    for (const b of branches) {
      console.log(`  ${b.branch_id} ${b.name} tz=${b.timezone} status=${b.status}`);
    }
    console.log(`machines: ${machines.length}`);
    for (const m of machines) {
      console.log(`  ${m.machine_id} ${m.code} kind=${m.kind} modbus=${m.modbus_address} deleted=${m.deleted_at ? "yes" : "no"}`);
    }

    const usage = await walkUsage(source);
    console.log(`usage rows: ${usage.count}`);
    if (usage.first) console.log(`usage first created_at=${usage.first.created_at.toISOString()} source_event=${usage.first.source_event_id}`);
    if (usage.last) console.log(`usage last  created_at=${usage.last.created_at.toISOString()} source_event=${usage.last.source_event_id}`);

    const temp = await walkTemperature(source);
    console.log(`temperature rows: ${temp.count}`);
    if (temp.first) console.log(`temperature first ingested_at=${temp.first.ingested_at.toISOString()} occurred_at=${temp.first.occurred_at.toISOString()}`);
    if (temp.last) console.log(`temperature last  ingested_at=${temp.last.ingested_at.toISOString()} occurred_at=${temp.last.occurred_at.toISOString()}`);
  } finally {
    await source.close();
  }
}

async function walkUsage(source: ReturnType<typeof createPostgresSource>) {
  let count = 0;
  let cursor: UsageCursor = { at: new Date(0).toISOString(), id: "00000000-0000-0000-0000-000000000000" };
  let first: UsageRow | null = null;
  let last: UsageRow | null = null;
  for (;;) {
    const rows = await source.listUsageSince(cursor, { limit: 5000 });
    if (rows.length === 0) break;
    count += rows.length;
    if (!first) first = rows[0]!;
    last = rows[rows.length - 1]!;
    cursor = { at: last.created_at.toISOString(), id: last.usage_id };
    if (rows.length < 5000) break;
  }
  return { count, first, last };
}

async function walkTemperature(source: ReturnType<typeof createPostgresSource>) {
  let count = 0;
  let cursor: TemperatureCursor = { at: new Date(0).toISOString(), seq: "0", id: "" };
  let first: TemperatureSampleRow | null = null;
  let last: TemperatureSampleRow | null = null;
  for (;;) {
    const rows = await source.listTemperatureSince(cursor, { limit: 50000 });
    if (rows.length === 0) break;
    count += rows.length;
    if (!first) first = rows[0]!;
    last = rows[rows.length - 1]!;
    cursor = { at: last.ingested_at.toISOString(), seq: last.seq, id: last.event_id };
    if (rows.length < 50000) break;
  }
  return { count, first, last };
}