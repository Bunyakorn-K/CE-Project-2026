import { describe, expect, it } from "vitest";
import { buildSeedRows, shouldRefuseSeed } from "./seed-analytics";

describe("seed-analytics", () => {
  it("builds deterministic rows for a fixed seed", () => {
    expect(buildSeedRows(20260826, 60)).toEqual(buildSeedRows(20260826, 60));
  });

  it("tags every usage row with a synthetic source_event_id", () => {
    const { usage } = buildSeedRows(20260826, 30);
    expect(usage.length).toBeGreaterThan(0);
    for (const row of usage) expect(String(row.source_event_id)).toMatch(/^synthetic:/);
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
