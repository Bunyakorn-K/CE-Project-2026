import { createHash } from "node:crypto";
import "../src/config";
import { createClickHouseClient, type ClickHouseExecutor } from "../src/analytics/clickhouse";

export const SEED_BRANCHES = [
  { tenantId: "00000000-0000-4000-8000-000000000001", branchId: "10000000-0000-4000-8000-000000000001", name: "SYNTH-Rama II" },
  { tenantId: "00000000-0000-4000-8000-000000000001", branchId: "10000000-0000-4000-8000-000000000002", name: "SYNTH-Bang Khae" }
];

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let counter = 0;
function synthId(rand: () => number) {
  counter += 1;
  return `synthetic:${Math.floor(rand() * 1e12).toString(16).padStart(11, "0")}${counter}`;
}

// Same generator with a `synthetic-session:` prefix, for machine_session_id.
// The `synthetic-` marker stays readable so anyone inspecting the column in
// the warehouse can tell the value came from this script.
function synthSessionId(rand: () => number) {
  return synthId(rand).replace("synthetic:", "synthetic-session:");
}

// `fact_machine_usage.usage_id` is declared UUID in apps/etl/src/schema.ts, so
// the `synthetic:` key cannot be written into it verbatim — ClickHouse rejects
// the whole insert with Code 27 CANNOT_PARSE_INPUT_ASSERTION_FAILED. We keep
// the synthetic key as the source of truth for the row and derive a well-formed
// 128-bit id from it with md5. The derivation is pure (no clock, no RNG), so the
// committed PRNG seed still reproduces byte-identical ids. `source_event_id`
// stays a String column and keeps its `synthetic:` prefix, which is what
// shouldRefuseSeed and the demo-dataSource labelling both key off.
function synthUuid(key: string): string {
  const hex = createHash("md5").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function shouldRefuseSeed(existingRealRowCount: number, force: boolean) {
  return existingRealRowCount > 0 && !force;
}

// `machine_session_id` is Nullable(String) in the warehouse and the ETL copies
// it straight through from IRIS `attribution_machine_session_id`
// (apps/etl/src/postgres.ts), so it is NULL whenever the source could not
// attribute a cycle to a session. The dashboard `cycles` KPI counts DISTINCT
// non-null session ids on paid/finished rows
// (apps/api/src/report/clickhouse-report.ts), so a seed that leaves the column
// NULL everywhere reports 0 cycles however full the table is. We attribute a
// minority of cycles to a session and let the rest stay standalone: a session
// groups a short run of cycles on one machine, and sessions never cross a day.
const SESSION_CYCLE_RATE = 0.4;
const MAX_CYCLES_PER_SESSION = 3;

export function buildSeedRows(seed: number, days: number) {
  counter = 0;
  const rand = mulberry32(seed);
  const machines = SEED_BRANCHES.flatMap((branch, bi) =>
    ["washer", "washer", "dryer"].map((kind, mi) => ({
      tenant_id: branch.tenantId,
      branch_id: branch.branchId,
      machine_id: `20000000-0000-4000-8000-${String(bi)}${mi}000000000000`.slice(0, 36),
      machine_code: `SYNTH-${bi + 1}-${kind.slice(0, 1).toUpperCase()}${mi + 1}`,
      machine_kind: kind,
      modbus_address: bi * 10 + mi + 1,
      active: 1,
      source_updated_at: "2026-08-26 00:00:00.000",
      extracted_at: "2026-08-26 00:00:00.000"
    }))
  );
  const branches = SEED_BRANCHES.map((branch) => ({
    tenant_id: branch.tenantId,
    branch_id: branch.branchId,
    branch_name: branch.name,
    timezone: "Asia/Bangkok",
    active: 1,
    source_updated_at: "2026-08-26 00:00:00.000",
    extracted_at: "2026-08-26 00:00:00.000"
  }));

  const usage: Record<string, unknown>[] = [];
  const openSessions = new Map<string, { id: string; cycles: number }>();
  const end = Date.UTC(2026, 7, 26);
  for (let dayOffset = days; dayOffset > 0; dayOffset -= 1) {
    const dayStart = end - dayOffset * 86_400_000;
    const dow = new Date(dayStart).getUTCDay();
    const cyclesToday = 20 + Math.floor(rand() * (dow === 0 || dow === 6 ? 30 : 15));
    openSessions.clear();
    for (let i = 0; i < cyclesToday; i += 1) {
      const hourSkew = rand() < 0.55 ? 9 + Math.floor(rand() * 6) : 15 + Math.floor(rand() * 7);
      const startedAt = new Date(dayStart + hourSkew * 3_600_000 + Math.floor(rand() * 3_600_000));
      const durationMin = 30 + Math.floor(rand() * 40);
      const machine = machines[Math.floor(rand() * machines.length)]!;
      const amountSatang = (machine.machine_kind === "dryer" ? 2000 : 4000) + Math.floor(rand() * 500);
      const usageKey = synthId(rand);
      const machineKey = String(machine.machine_id);
      let machineSessionId: string | null = null;
      if (rand() < SESSION_CYCLE_RATE) {
        const open = openSessions.get(machineKey);
        if (open && open.cycles < MAX_CYCLES_PER_SESSION) {
          open.cycles += 1;
          machineSessionId = open.id;
        } else {
          const id = synthSessionId(rand);
          openSessions.set(machineKey, { id, cycles: 1 });
          machineSessionId = id;
        }
      } else {
        // a standalone cycle closes any run of cycles for this machine
        openSessions.delete(machineKey);
      }
      usage.push({
        tenant_id: String(machine.tenant_id),
        branch_id: String(machine.branch_id),
        machine_id: String(machine.machine_id),
        usage_id: synthUuid(usageKey),
        source_event_id: usageKey,
        machine_session_id: machineSessionId,
        started_at: startedAt.toISOString().replace("T", " ").slice(0, 23),
        finished_at: new Date(startedAt.getTime() + durationMin * 60_000).toISOString().replace("T", " ").slice(0, 23),
        duration_min: durationMin,
        program_id: 1 + Math.floor(rand() * 3),
        program_name: ["quick", "standard", "heavy"][Math.floor(rand() * 3)],
        temp_level: machine.machine_kind === "dryer" ? "high" : ["cold", "warm", "hot"][Math.floor(rand() * 3)],
        amount_satang: Math.round(amountSatang),
        // `finished` (Enum8 value 4) and `cancelled` (5) mirror a completed
        // cycle; the dashboard counts revenue and cycles on statuses 2 and 4,
        // so `finished` rows are the ones QA should see populate.
        status: rand() < 0.92 ? "finished" : "cancelled",
        initiated_via: rand() < 0.5 ? "liff" : "staff_v3",
        attribution_state: "exact",
        attribution_source: "liff",
        source_created_at: startedAt.toISOString().replace("T", " ").slice(0, 23),
        source_updated_at: startedAt.toISOString().replace("T", " ").slice(0, 23),
        extracted_at: "2026-08-26 00:00:00.000"
      });
    }
  }

  return { branches, machines, usage };
}

export async function runSeed(executor: ClickHouseExecutor, options: { force?: boolean; days?: number } = {}) {
  const countRows = await executor<{ real_count: number }>(
    "SELECT countIf(NOT startsWith(source_event_id, 'synthetic:')) AS real_count FROM fact_machine_usage"
  );
  if (shouldRefuseSeed(countRows[0]?.real_count ?? 0, Boolean(options.force))) {
    throw new Error("Refusing to seed: fact_machine_usage contains non-synthetic rows. Re-run with --force to allow.");
  }
  const { branches, machines, usage } = buildSeedRows(20260826, options.days ?? 60);
  await insertRows(executor, "dim_branch", branches);
  await insertRows(executor, "dim_machine", machines);
  await insertRows(executor, "fact_machine_usage", usage);
  console.log(`Seeded ${branches.length} branches, ${machines.length} machines, ${usage.length} synthetic usage rows.`);
}

// insertRows sends the INSERT statement including the inline JSON payload as one POST body —
// acceptable because content is script-generated, never user input.
async function insertRows(executor: ClickHouseExecutor, table: string, rows: Record<string, unknown>[]) {
  for (let offset = 0; offset < rows.length; offset += 500) {
    const chunk = rows.slice(offset, offset + 500);
    const payload = chunk.map((row) => JSON.stringify(row)).join("\n");
    await executor(`INSERT INTO ${table} FORMAT JSONEachRow\n${payload}`);
  }
}

const invokedDirectly = process.argv[1]?.endsWith("seed-analytics.ts");
if (invokedDirectly) {
  runSeed(createClickHouseClient(), { force: process.argv.includes("--force") }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
