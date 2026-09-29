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

// Mirrors fahrenheitToCelsius in apps/etl/src/transform.ts:103. The ETL derives
// temperature_c from the raw Fahrenheit integer, so the seed must use the same
// formula or the two columns disagree. apps/api does not depend on
// @laundrytwin/etl, so the formula is restated here rather than imported; keep
// the two in step.
function fahrenheitToCelsius(f: number): number {
  return Math.round(((f - 32) * 5) / 9 * 100) / 100;
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

  return {
    branches,
    machines,
    usage,
    temperature: buildTemperatureRows(rand, usage, machines),
    weather: buildWeatherRows(rand, days)
  };
}

// ---- fact_temperature_sample: dryer-shaped rise/fall curves ----
//
// Shape authority is the design spec
// (docs/superpowers/specs/2026-08-26-analytics-dev-platform-design.md:104 —
// "fact_temperature_sample: dryer-shaped rise/fall curves") and the columns are
// the ones apps/etl/src/schema.ts:92-105 declares for the live warehouse.
//
// There is no `source_event_id` column on this table. The synthetic marker lives
// in `event_id` (String), which is what the curve query actually keys off:
// apps/api/src/analytics/queries.ts:170 counts
// `event_id LIKE 'synthetic:%'` into synthCount, and
// dataSourceFromCounts (apps/api/src/analytics/envelope.ts:12) turns that into
// meta.dataSource. Temperature rows are therefore detectable in exactly the way
// usage rows are, just under a different column name.
//
// Only DRYERS get a curve. A dryer heats air on purpose; a washer's drum
// temperature depends on a fill register whose meaning and scaling are still
// unverified (see the strict physical/safety boundaries in the repo guide), so
// inventing washer curves would be a claim about a register map we do not have
// evidence for. Only `finished` cycles get a curve: a `cancelled` cycle never
// ran to completion, and fabricating its full heat/plateau/cool profile would be
// the "do not fabricate a value" violation.
const TEMPERATURE_SAMPLE_INTERVAL_MIN = 3;

type DryerProfile = {
  ambientF: number;
  setpointF: number;
  /** Share of the cycle spent ramping up. */
  heatShare: number;
  /** Share of the cycle spent on the plateau. */
  plateauShare: number;
};

function buildDryerProfiles(rand: () => number, dryers: Array<Record<string, unknown>>) {
  return new Map(
    dryers.map((machine) => [
      String(machine.machine_id),
      {
        // 82-90F is 28-32C, a Bangkok ambient for late June through late August.
        ambientF: 82 + rand() * 8,
        // 118-150F is 48-66C: the high-heat band a commercial dryer runs at.
        setpointF: 118 + rand() * 32,
        heatShare: 0.22 + rand() * 0.14,
        plateauShare: 0.38 + rand() * 0.2
      } satisfies DryerProfile
    ])
  );
}

/** Ramp -> plateau -> cool-down, in whole degrees Fahrenheit. */
function dryerTemperatureF(
  profile: DryerProfile,
  durationMin: number,
  elapsedMin: number,
  setpointF: number,
  coolFloorF: number
): number {
  const heatEnd = durationMin * profile.heatShare;
  const plateauEnd = heatEnd + durationMin * profile.plateauShare;
  if (elapsedMin <= heatEnd) {
    // The heating element pulls hard at first and the drum mass catches up, so
    // the ramp is concave rather than linear.
    const progress = heatEnd > 0 ? elapsedMin / heatEnd : 1;
    return profile.ambientF + (setpointF - profile.ambientF) * Math.sin((progress * Math.PI) / 2);
  }
  if (elapsedMin <= plateauEnd) return setpointF;
  const coolMin = Math.max(1, durationMin - plateauEnd);
  const progress = (elapsedMin - plateauEnd) / coolMin;
  return setpointF - (setpointF - coolFloorF) * (1 - Math.cos((progress * Math.PI) / 2));
}

function buildTemperatureRows(
  rand: () => number,
  usage: Record<string, unknown>[],
  machines: Record<string, unknown>[]
) {
  const dryers = machines.filter((machine) => machine.machine_kind === "dryer");
  const profiles = buildDryerProfiles(rand, dryers);
  // A real edge device counts its own samples, so seq is per machine and
  // monotonic across the whole window, not per cycle.
  const seqByMachine = new Map(dryers.map((machine) => [String(machine.machine_id), 100_000]));

  const rows: Record<string, unknown>[] = [];
  // The usage rows are generated in PRNG order, not in clock order (each cycle
  // picks a random hour inside its day), so walking them as-is would hand out
  // seq numbers that go backwards in time. A real device counts up with time,
  // so the cycles are ordered by start before any seq is handed out.
  const cycles = usage
    .filter((cycle) => cycle.status === "finished" && profiles.has(String(cycle.machine_id)))
    .map((cycle) => ({ cycle, startedMs: Date.parse(`${String(cycle.started_at).replace(" ", "T")}Z`) }))
    .sort((a, b) => a.startedMs - b.startedMs);

  for (const { cycle, startedMs } of cycles) {
    const machineId = String(cycle.machine_id);
    const profile = profiles.get(machineId)!;
    const durationMin = Number(cycle.duration_min);
    // Per-cycle jitter keeps two cycles on the same machine from being the same
    // curve, without changing the machine's overall character.
    const setpointF = profile.setpointF + (rand() - 0.5) * 6;
    const coolFloorF = profile.ambientF + 6 + rand() * 12;

    for (let elapsedMin = 0; elapsedMin <= durationMin; elapsedMin += TEMPERATURE_SAMPLE_INTERVAL_MIN) {
      const occurredMs = startedMs + elapsedMin * 60_000;
      const jittered = dryerTemperatureF(profile, durationMin, elapsedMin, setpointF, coolFloorF) + (rand() - 0.5) * 1.6;
      const temperatureF = Math.round(jittered);
      const heatEnd = durationMin * profile.heatShare;
      const plateauEnd = heatEnd + durationMin * profile.plateauShare;
      // `phase` is a free-form String copied verbatim from the source
      // (apps/etl/src/schema.ts:103) with no documented enumeration, so these
      // three labels are chosen to be legible in the UI and are NOT a claim
      // about a verified register mapping.
      const phase = elapsedMin <= heatEnd ? "heat" : elapsedMin <= plateauEnd ? "dry" : "cool";
      const nextSeq = (seqByMachine.get(machineId) ?? 0) + 1;
      seqByMachine.set(machineId, nextSeq);
      rows.push({
        tenant_id: String(cycle.tenant_id),
        branch_id: String(cycle.branch_id),
        machine_id: machineId,
        // The synthetic marker. See the block comment above on why this table
        // carries it in `event_id` rather than `source_event_id`.
        event_id: synthId(rand),
        seq: nextSeq,
        // frame_seq is Nullable(UInt64) because the source does not always carry
        // a frame counter and the ETL preserves the gap (schema.ts:98).
        frame_seq: rand() < 0.67 ? 1 + Math.floor(rand() * 60) : null,
        occurred_at: chTimestamp(occurredMs),
        ingested_at: chTimestamp(occurredMs + 2_000 + Math.floor(rand() * 4_000)),
        temperature_f: temperatureF,
        temperature_c: fahrenheitToCelsius(temperatureF),
        phase,
        extracted_at: "2026-08-26 00:00:00.000"
      });
    }
  }
  return rows;
}

// ---- fact_weather_sample: hourly branch-tagged observations ----
//
// Shape authority is apps/etl/src/weather.ts:109-134 (`normalizeForecast`):
// timestamp is a UTC instant, sub_district and district are always null (there
// is no per-position source), and every reading is nullable because a missing
// TMD field stays null and is never invented. Units are Celsius, percent, and
// mm per docs/03_data_contracts/data_contracts.md:22-27.
//
// `weather_cond` is deliberately left NULL. The same contract line calls the
// TMD condition code "opaque until TMD's code table is pinned in docs", so any
// integer we wrote would be a fabricated code-to-meaning mapping.
//
// There is NO synthetic marker column on this table: the nine columns in
// apps/etl/src/schema.ts FACT_WEATHER_COLUMNS leave no free-text field that is
// not a location label or a reading. Because of that, the F-12 correlation
// cannot distinguish these rows from real TMD observations, so
// `weatherDataSource` (apps/api/src/analytics/weather.ts) reports a non-empty
// weather window as `dataSource: "unverifiable"` instead of asserting `real`.
// Fixing it properly needs an ADD COLUMN migration on the live warehouse.
const WEATHER_PROVINCE = "กรุงเทพมหานคร";

// Both seeded branches are Bangkok districts, so both report the same province —
// that is what the TMD endpoint returns for a province query. Their SERIES
// differ because real TMD returns one identical series for every province (a
// known limitation, docs/01_requirements/system_requirement.md:41) and seeding
// that would make the per-branch join look correct while proving nothing. The
// divergence is a deliberate QA property of the seed, not a claim about TMD.
const WEATHER_BRANCH_PROFILES = [
  { meanC: 30.2, driftPerDayC: 0.004, amplitudeC: 3.4, humidityBase: 78, wetDayRate: 0.35 },
  { meanC: 30.7, driftPerDayC: 0.002, amplitudeC: 3.9, humidityBase: 80, wetDayRate: 0.42 }
];

function buildWeatherRows(rand: () => number, days: number) {
  const rows: Record<string, unknown>[] = [];
  const end = Date.UTC(2026, 7, 26);
  for (let dayOffset = days; dayOffset > 0; dayOffset -= 1) {
    const dayStart = end - dayOffset * 86_400_000;
    for (const [bi, branch] of SEED_BRANCHES.entries()) {
      const profile = WEATHER_BRANCH_PROFILES[bi]!;
      const dailyMeanC = profile.meanC + dayOffset * profile.driftPerDayC + (rand() - 0.5) * 1.2;
      // Bangkok is in its rainy season across this window, so most days are
      // dry-ish and a minority carry a short rain burst.
      const wetDay = rand() < profile.wetDayRate;
      const rainStartHour = wetDay ? Math.floor(rand() * 18) : -1;
      const rainHours = wetDay ? 1 + Math.floor(rand() * 3) : 0;
      for (let hourUtc = 0; hourUtc < 24; hourUtc += 1) {
        // Bangkok is a fixed UTC+7 with no DST, so local hour is a constant
        // offset and the daily peak sits at 14:00 local.
        const localHour = (hourUtc + 7) % 24;
        const diurnalC = Math.cos(((localHour - 14) * 2 * Math.PI) / 24) * profile.amplitudeC;
        const tempC = round1(dailyMeanC + diurnalC + (rand() - 0.5) * 0.8);
        const raining = hourUtc >= rainStartHour && hourUtc < rainStartHour + rainHours;
        const rainMm = raining ? round1(0.4 + rand() * 7.6) : 0;
        const humidityPct = round1(
          clamp(profile.humidityBase - 2.2 * (tempC - dailyMeanC) + (raining ? 9 : 0) + (rand() - 0.5) * 3, 45, 99)
        );
        rows.push({
          timestamp: chTimestamp(dayStart + hourUtc * 3_600_000),
          tenant_id: branch.tenantId,
          branch_id: branch.branchId,
          province: WEATHER_PROVINCE,
          sub_district: null,
          district: null,
          // TMD omits a field rather than sending a placeholder, and the ETL
          // keeps the gap. A small share of synthetic rows do the same so the
          // documented NULL path is exercised instead of assumed.
          weather_temp_c: rand() < 0.015 ? null : tempC,
          weather_humidity_pct: humidityPct,
          weather_rain_mm: rainMm,
          weather_cond: null
        });
      }
    }
  }
  return rows;
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** DateTime64(3) UTC literal — the same form apps/etl/src/transform.ts:92 emits. */
function chTimestamp(epochMs: number) {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 23);
}

export async function runSeed(executor: ClickHouseExecutor, options: { force?: boolean; days?: number } = {}) {
  const countRows = await executor<{ real_count: number }>(
    "SELECT countIf(NOT startsWith(source_event_id, 'synthetic:')) AS real_count FROM fact_machine_usage"
  );
  if (shouldRefuseSeed(countRows[0]?.real_count ?? 0, Boolean(options.force))) {
    throw new Error("Refusing to seed: fact_machine_usage contains non-synthetic rows. Re-run with --force to allow.");
  }
  // Same guard for the temperature table, whose synthetic marker is `event_id`.
  // fact_weather_sample cannot be guarded at all — it has no marker column, so
  // a real TMD row landing there would be invisible to this script.
  const tempCountRows = await executor<{ real_count: number }>(
    "SELECT countIf(NOT startsWith(event_id, 'synthetic:')) AS real_count FROM fact_temperature_sample"
  );
  if (shouldRefuseSeed(tempCountRows[0]?.real_count ?? 0, Boolean(options.force))) {
    throw new Error("Refusing to seed: fact_temperature_sample contains non-synthetic rows. Re-run with --force to allow.");
  }
  const { branches, machines, usage, temperature, weather } = buildSeedRows(20260826, options.days ?? 60);
  await insertRows(executor, "dim_branch", branches);
  await insertRows(executor, "dim_machine", machines);
  await insertRows(executor, "fact_machine_usage", usage);
  await insertRows(executor, "fact_temperature_sample", temperature);
  await insertRows(executor, "fact_weather_sample", weather);
  console.log(
    `Seeded ${branches.length} branches, ${machines.length} machines, ${usage.length} synthetic usage rows, ` +
      `${temperature.length} synthetic temperature samples, ${weather.length} synthetic weather observations.`
  );
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
