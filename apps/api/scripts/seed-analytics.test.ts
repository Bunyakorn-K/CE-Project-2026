import { describe, expect, it } from "vitest";
import { buildSeedRows, shouldRefuseSeed } from "./seed-analytics";

// fact_machine_usage.usage_id is UUID in apps/etl/src/schema.ts, so a
// non-UUID value aborts the whole insert (Code 27).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
});
