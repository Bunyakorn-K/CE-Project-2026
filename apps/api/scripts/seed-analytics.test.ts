import { describe, expect, it } from "vitest";
import { buildSeedRows, SEED_BRANCHES, shouldRefuseSeed } from "./seed-analytics";

// fact_machine_usage.usage_id is UUID in apps/etl/src/schema.ts, so a
// non-UUID value aborts the whole insert (Code 27).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Column sets mirrored from apps/etl/src/schema.ts:92-124. The seed inserts
// against the live warehouse DDL, so a renamed or added column has to be a
// deliberate edit here too — an unexpected key would be rejected by the INSERT,
// and a missing one would silently default to 0/empty.
const TEMPERATURE_COLUMNS = [
  "tenant_id",
  "branch_id",
  "machine_id",
  "event_id",
  "seq",
  "frame_seq",
  "occurred_at",
  "ingested_at",
  "temperature_f",
  "temperature_c",
  "phase",
  "extracted_at"
];
const WEATHER_COLUMNS = [
  "timestamp",
  "tenant_id",
  "branch_id",
  "province",
  "sub_district",
  "district",
  "weather_temp_c",
  "weather_humidity_pct",
  "weather_rain_mm",
  "weather_cond"
];

const CH_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

/** Mirrors TEMPERATURE_SAMPLE_INTERVAL_MIN in ./seed-analytics. */
const SAMPLE_INTERVAL_MIN = 3;

/**
 * Split the temperature rows into one array per generated curve. Inside one
 * curve the samples sit on an exact 3-minute grid and carry a contiguous block
 * of `seq` numbers on one machine, so a change in any of those ends the curve.
 * Time gaps alone are not enough and neither is seq alone: the usage seed puts
 * overlapping cycles on the same machine, so two curves can interleave in time
 * and their seq blocks can abut in the emitted order.
 */
function splitIntoCycles(rows: Array<Record<string, unknown>>) {
  const cycles: Array<Array<Record<string, unknown>>> = [];
  let current: Array<Record<string, unknown>> = [];
  let previous: { machineId: string; seq: number; at: number } | null = null;
  for (const row of rows) {
    const machineId = String(row.machine_id);
    const seq = Number(row.seq);
    const at = Date.parse(`${row.occurred_at}Z`);
    const continues =
      previous !== null &&
      previous.machineId === machineId &&
      seq === previous.seq + 1 &&
      (at - previous.at) / 60_000 === SAMPLE_INTERVAL_MIN;
    if (!continues) {
      if (current.length > 0) cycles.push(current);
      current = [];
    }
    current.push(row);
    previous = { machineId, seq, at };
  }
  if (current.length > 0) cycles.push(current);
  return cycles;
}

describe("seed-analytics", () => {
  it("builds deterministic rows for a fixed seed", () => {
    expect(buildSeedRows(20260826, 60)).toEqual(buildSeedRows(20260826, 60));
  });

  it("tags every usage row with a synthetic source_event_id", () => {
    const { usage } = buildSeedRows(20260826, 30);
    expect(usage.length).toBeGreaterThan(0);
    for (const row of usage) expect(String(row.source_event_id)).toMatch(/^synthetic:/);
  });

  it("writes usage_id as a well-formed UUID without touching the synthetic source_event_id", () => {
    const { usage } = buildSeedRows(20260826, 30);
    for (const row of usage) {
      expect(String(row.usage_id)).toMatch(UUID);
      // the shouldRefuseSeed guard and the synthetic dataSource label both key
      // off this prefix; the UUID conversion must not consume it
      expect(String(row.source_event_id)).toMatch(/^synthetic:/);
      expect(String(row.source_event_id)).not.toMatch(UUID);
    }
  });

  it("derives usage_id deterministically and uniquely from the PRNG seed", () => {
    const first = buildSeedRows(20260826, 30).usage.map((row) => String(row.usage_id));
    const second = buildSeedRows(20260826, 30).usage.map((row) => String(row.usage_id));
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
    // a different seed must not reproduce the same ids
    const other = buildSeedRows(20260827, 30).usage.map((row) => String(row.usage_id));
    expect(other).not.toEqual(first);
  });

  it("attributes a minority of cycles to a machine session and leaves the rest standalone", () => {
    const { usage } = buildSeedRows(20260826, 30);
    const withSession = usage.filter((row) => row.machine_session_id !== null);
    expect(withSession.length).toBeGreaterThan(0);
    // a 100% session rate would misrepresent the data — real usage has
    // standalone cycles with no attribution
    expect(withSession.length).toBeLessThan(usage.length / 2);
    for (const row of withSession) {
      // a reader inspecting any seeded column can tell it is synthetic
      expect(String(row.machine_session_id)).toMatch(/^synthetic-session:/);
      expect(String(row.machine_session_id)).not.toMatch(/^synthetic-session:synthetic:/);
    }

    // the dashboard counts DISTINCT session ids on statuses 2 and 4
    const counted = usage.filter((row) => row.machine_session_id !== null && (row.status === "paid" || row.status === "finished"));
    expect(new Set(counted.map((row) => String(row.machine_session_id))).size).toBeGreaterThan(0);
    // a session spans more than one cycle, so uniqExactIf has something to collapse
    const perSession = new Map<string, number>();
    for (const row of withSession) {
      const key = String(row.machine_session_id);
      perSession.set(key, (perSession.get(key) ?? 0) + 1);
    }
    expect(Math.max(...perSession.values())).toBeGreaterThan(1);
  });

  it("keeps amounts as integer satang and weekday-skewed hours", () => {
    const { usage } = buildSeedRows(20260826, 30);
    for (const row of usage) {
      expect(Number.isInteger(row.amount_satang)).toBe(true);
      expect(row.amount_satang).toBeGreaterThan(0);
    }
    expect(new Set(usage.map((row) => row.amount_satang)).size).toBeGreaterThan(1);
  });

  it("refuses to seed over real data unless forced", () => {
    expect(shouldRefuseSeed(5, false)).toBe(true);
    expect(shouldRefuseSeed(5, true)).toBe(false);
    expect(shouldRefuseSeed(0, false)).toBe(false);
  });

  it("writes temperature rows against the declared schema, with both units", () => {
    const { temperature } = buildSeedRows(20260826, 30);
    expect(temperature.length).toBeGreaterThan(0);
    for (const row of temperature) {
      expect(Object.keys(row).sort()).toEqual([...TEMPERATURE_COLUMNS].sort());
      expect(String(row.occurred_at)).toMatch(CH_TIMESTAMP);
      expect(String(row.ingested_at)).toMatch(CH_TIMESTAMP);
      expect(String(row.tenant_id)).toMatch(UUID);
      expect(String(row.branch_id)).toMatch(UUID);
    }
  });

  it("tags every temperature row with a synthetic event_id the curve query can count", () => {
    // There is no source_event_id on fact_temperature_sample. The curve query
    // (apps/api/src/analytics/queries.ts:170) counts `event_id LIKE
    // 'synthetic:%'` into synthCount, which is what meta.dataSource is built
    // from, so event_id is the only place the marker can live.
    const { temperature } = buildSeedRows(20260826, 30);
    for (const row of temperature) {
      expect(String(row.event_id)).toMatch(/^synthetic:/);
      expect(String(row.event_id)).not.toMatch(UUID);
    }
    expect(new Set(temperature.map((row) => String(row.event_id))).size).toBe(temperature.length);
  });

  it("derives temperature_c from temperature_f exactly as the ETL does", () => {
    // apps/etl/src/transform.ts:103 — if the seed rounds differently the two
    // columns disagree and the panel's CJK average stops matching the source.
    const { temperature } = buildSeedRows(20260826, 30);
    for (const row of temperature) {
      const f = Number(row.temperature_f);
      // Int16 column (schema.ts:101) and the contract calls for validating
      // against reasonable sensor boundaries.
      expect(Number.isInteger(f)).toBe(true);
      expect(f).toBeGreaterThanOrEqual(-32768);
      expect(f).toBeLessThanOrEqual(32767);
      // 28-32C ambient up to a ~66C dryer high-heat band.
      expect(f).toBeGreaterThan(70);
      expect(f).toBeLessThan(175);
      expect(row.temperature_c).toBe(Math.round(((f - 32) * 5) / 9 * 100) / 100);
    }
  });

  it("shapes each dryer cycle as a ramp, a plateau and a cool-down", () => {
    const { temperature } = buildSeedRows(20260826, 30);
    const cycles = splitIntoCycles(temperature);
    expect(cycles.length).toBeGreaterThan(0);
    for (const cycle of cycles) {
      const values = cycle.map((row) => Number(row.temperature_f));
      const phases = cycle.map((row) => String(row.phase));
      const peak = Math.max(...values);
      const peakIndex = values.indexOf(peak);
      // The peak is interior: the curve rises into it and falls out of it.
      expect(peakIndex).toBeGreaterThan(0);
      expect(peakIndex).toBeLessThan(values.length - 1);
      expect(values[0]).toBeLessThan(peak);
      expect(values[values.length - 1]).toBeLessThan(peak);
      expect(phases[0]).toBe("heat");
      expect(phases[phases.length - 1]).toBe("cool");
      expect(phases).toContain("dry");
      // A flat series would render as a line with no shape to QA.
      expect(new Set(values).size).toBeGreaterThan(1);
    }
  });

  it("varies the curve by machine and by cycle", () => {
    const { temperature } = buildSeedRows(20260826, 60);
    const byMachine = new Map<string, Array<Record<string, unknown>>>();
    for (const row of temperature) {
      const bucket = byMachine.get(String(row.machine_id)) ?? [];
      bucket.push(row);
      byMachine.set(String(row.machine_id), bucket);
    }
    expect(byMachine.size).toBe(2); // one dryer per seeded branch
    const peaks = [...byMachine.values()].map((rows) => Math.max(...rows.map((row) => Number(row.temperature_f))));
    expect(new Set(peaks).size).toBe(2);

    const cycles = splitIntoCycles(temperature);
    const firstCyclePeaks = cycles.map((cycle) => Math.max(...cycle.map((row) => Number(row.temperature_f))));
    expect(new Set(firstCyclePeaks).size).toBeGreaterThan(1);
  });

  it("only seeds dryers, only for finished cycles, inside the cycle window", () => {
    const { temperature, usage, machines } = buildSeedRows(20260826, 30);
    const dryerIds = new Set(
      machines.filter((machine) => machine.machine_kind === "dryer").map((machine) => String(machine.machine_id))
    );
    expect(dryerIds.size).toBe(2);
    // Washer drum temperature depends on a fill register whose scaling is still
    // unverified, so no washer curve is invented.
    for (const row of temperature) expect(dryerIds.has(String(row.machine_id))).toBe(true);

    // Each sample sits inside a `finished` dryer cycle's [started_at, finished_at].
    const windows = usage
      .filter((row) => row.status === "finished" && dryerIds.has(String(row.machine_id)))
      .map((row) => ({
        machine: String(row.machine_id),
        start: Date.parse(`${row.started_at}Z`),
        end: Date.parse(`${row.finished_at}Z`)
      }));
    expect(windows.length).toBeGreaterThan(0);
    for (const row of temperature) {
      const at = Date.parse(`${row.occurred_at}Z`);
      const inWindow = windows.some(
        (window) => window.machine === String(row.machine_id) && at >= window.start && at <= window.end
      );
      expect(inWindow).toBe(true);
      // ingested_at is the receive time and must not precede the event time.
      expect(Date.parse(`${row.ingested_at}Z`)).toBeGreaterThanOrEqual(at);
    }
  });

  it("numbers temperature samples uniquely and counts up within each curve", () => {
    // seq is UInt64 and the ETL carries the edge device's own sample counter
    // through (apps/etl/src/transform.ts:221). It cannot be monotonic per
    // machine across the whole window: the usage seed puts overlapping cycles
    // on the same machine, so two curves interleave in time. Uniqueness plus
    // per-curve ascent is the invariant that actually holds.
    const { temperature } = buildSeedRows(20260826, 30);
    const perMachine = new Map<string, number[]>();
    for (const row of temperature) {
      const bucket = perMachine.get(String(row.machine_id)) ?? [];
      bucket.push(Number(row.seq));
      perMachine.set(String(row.machine_id), bucket);
    }
    for (const seqs of perMachine.values()) {
      expect(new Set(seqs).size).toBe(seqs.length);
    }
    for (const cycle of splitIntoCycles(temperature)) {
      const seqs = cycle.map((row) => Number(row.seq));
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    }
    // frame_seq is Nullable(UInt64) because the source does not always carry a
    // frame counter and the ETL preserves the gap (schema.ts:98).
    const frameSeqs = temperature.map((row) => row.frame_seq);
    expect(frameSeqs.some((value) => value === null)).toBe(true);
    expect(frameSeqs.some((value) => value !== null)).toBe(true);
  });

  it("writes weather rows against the declared schema with hour-aligned timestamps", () => {
    const { weather } = buildSeedRows(20260826, 30);
    expect(weather.length).toBe(30 * 24 * SEED_BRANCHES.length);
    for (const row of weather) {
      expect(Object.keys(row).sort()).toEqual([...WEATHER_COLUMNS].sort());
      // The F-12 join is toStartOfHour(u.started_at) = toStartOfHour(w.timestamp)
      // (apps/api/src/analytics/weather.ts:40); an off-hour row could never match.
      const timestamp = String(row.timestamp);
      expect(timestamp).toMatch(CH_TIMESTAMP);
      expect(`${timestamp.slice(14, 16)}:${timestamp.slice(17, 19)}.${timestamp.slice(20, 23)}`).toBe("00:00.000");
      expect(SEED_BRANCHES.map((branch) => branch.branchId)).toContain(String(row.branch_id));
    }
  });

  it("keeps weather readings inside plausible Bangkok bounds", () => {
    const { weather } = buildSeedRows(20260826, 30);
    const temps = weather.flatMap((row) => (row.weather_temp_c === null ? [] : [Number(row.weather_temp_c)]));
    expect(temps.length).toBeGreaterThan(0);
    // Late June to late August in Bangkok: ~24-36C.
    expect(Math.min(...temps)).toBeGreaterThan(20);
    expect(Math.max(...temps)).toBeLessThan(40);
    for (const row of weather) {
      const humidity = Number(row.weather_humidity_pct);
      expect(humidity).toBeGreaterThan(0);
      expect(humidity).toBeLessThanOrEqual(100);
      expect(Number(row.weather_rain_mm)).toBeGreaterThanOrEqual(0);
    }
    // Missing TMD fields stay NULL rather than being filled in; the correlation
    // query counts them as missingTemp, so the seed must produce some.
    expect(weather.some((row) => row.weather_temp_c === null)).toBe(true);
    // A seed with no rain would never exercise the rain correlation at all.
    expect(weather.some((row) => Number(row.weather_rain_mm) > 0)).toBe(true);
  });

  it("leaves the fields with no verified source null on weather rows", () => {
    // sub_district/district have no per-position source and are NULL today
    // (docs/03_data_contracts/data_contracts.md:23-24). weather_cond is left
    // null because the TMD code table is unpinned, so any integer would be a
    // fabricated code-to-meaning mapping (same file, line 27).
    const { weather } = buildSeedRows(20260826, 30);
    for (const row of weather) {
      expect(row.sub_district).toBeNull();
      expect(row.district).toBeNull();
      expect(row.weather_cond).toBeNull();
      expect(String(row.province)).not.toBe("");
    }
  });

  it("spans the same window as the usage data and varies per branch", () => {
    const { weather, usage, temperature } = buildSeedRows(20260826, 30);
    const usageDay = (value: string) => String(value).slice(0, 10);
    const usageDays = [...new Set(usage.map((row) => usageDay(row.started_at)))].sort();
    const weatherDays = [...new Set(weather.map((row) => usageDay(row.timestamp)))].sort();
    const temperatureDays = [...new Set(temperature.map((row) => usageDay(row.occurred_at)))].sort();
    // Panels need a consistent story: one shared window, not three disjoint ones.
    expect(weatherDays[0]).toBe(usageDays[0]);
    expect(weatherDays[weatherDays.length - 1]).toBe(usageDays[usageDays.length - 1]);
    expect(temperatureDays[0]).toBe(usageDays[0]);
    expect(temperatureDays[temperatureDays.length - 1]).toBe(usageDays[usageDays.length - 1]);

    // Every hour of every day is present for both branches.
    const hoursPerBranch = SEED_BRANCHES.map((branch) =>
      weather.filter((row) => row.branch_id === branch.branchId).length
    );
    expect(hoursPerBranch).toEqual([30 * 24, 30 * 24]);

    // Per-branch series differ, which is what makes the branch-scoped join
    // testable at all.
    const dailyMean = (branchId: string) => {
      const values = weather
        .filter((row) => row.branch_id === branchId && row.weather_temp_c !== null)
        .map((row) => Number(row.weather_temp_c));
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    };
    const means = SEED_BRANCHES.map((branch) => dailyMean(branch.branchId));
    expect(new Set(means.map((value) => value.toFixed(2))).size).toBe(SEED_BRANCHES.length);
  });

  it("reproduces the new tables deterministically for a fixed seed", () => {
    const first = buildSeedRows(20260826, 30);
    const second = buildSeedRows(20260826, 30);
    expect(second.temperature).toEqual(first.temperature);
    expect(second.weather).toEqual(first.weather);
    // A different seed must not reproduce the same series.
    const other = buildSeedRows(20260827, 30);
    expect(other.temperature).not.toEqual(first.temperature);
    expect(other.weather).not.toEqual(first.weather);
  });
});
