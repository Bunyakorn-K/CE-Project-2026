import { describe, expect, it } from "vitest";
import { temperatureSummary, type TemperatureSample, type TemperatureTruncation } from "./temperature-view";

const sample = (temperatureC: number | null, occurredAt = "2026-08-04 13:06:00"): TemperatureSample => ({
  occurredAt,
  temperatureC
});

const TRUNCATED: TemperatureTruncation = { returnedRows: 5000, totalRowsInRange: 8208, limit: 5000, kept: "newest" };

describe("temperatureSummary", () => {
  it("keeps a missing reading out of the arithmetic instead of counting it as zero", () => {
    const summary = temperatureSummary([sample(60.3), sample(null)]);

    expect(summary.average).toBe(60.3);
    expect(summary.min).toBe(60.3);
    expect(summary.max).toBe(60.3);
    expect(summary.unknown).toBe(1);
  });

  it("reports unavailable rather than a number when nothing was measured", () => {
    const summary = temperatureSummary([sample(null), sample(null)]);

    expect(summary.average).toBeNull();
    expect(summary.min).toBeNull();
    expect(summary.max).toBeNull();
  });

  // The defect: avg/min/max were computed over a silently truncated slice and
  // labelled with the full requested range.
  it("does not claim the full range once the server reports truncation", () => {
    const summary = temperatureSummary([sample(54.6), sample(63.3), sample(30.6)], TRUNCATED);

    expect(summary.coversFullRange).toBe(false);
    expect(summary.coverage).toBe("แสดง 3 จาก 8,208 แถว — ข้อมูลก่อนหน้านี้ไม่ได้แสดง");
  });

  // Thai locale renders the Buddhist era, which is what every other date on this
  // page shows, so the scope note matches its neighbours rather than the ISO year.
  it("states the covered window so the KPIs are not read as range-wide", () => {
    const summary = temperatureSummary([sample(54.6, "2026-07-22 15:31:00"), sample(63.3, "2026-08-25 22:21:00")], TRUNCATED);

    expect(summary.scopeNote).toBe("ค่านี้ครอบคลุมเฉพาะ 22 ก.ค. 2569 15:31 ถึง 25 ส.ค. 2569 22:21");
  });

  it("keeps the full-range claim when nothing was truncated", () => {
    const summary = temperatureSummary([sample(54.6), sample(63.3)]);

    expect(summary.coversFullRange).toBe(true);
    expect(summary.coverage).toBeNull();
    expect(summary.scopeNote).toBeNull();
  });

  it("still shows the numbers for a truncated window, clearly marked as partial", () => {
    const summary = temperatureSummary([sample(54.6), sample(63.3), sample(30.6)], TRUNCATED);

    expect(summary.average).toBe(49.5);
    expect(summary.min).toBe(30.6);
    expect(summary.max).toBe(63.3);
    expect(summary.coversFullRange).toBe(false);
  });

  // A caller could pass a stale or malformed marker; the numbers must still be
  // honest rather than silently promoted to a full-range claim.
  it("does not invent a full-range claim from a marker with no rows", () => {
    const summary = temperatureSummary([], { ...TRUNCATED, returnedRows: 0 });

    expect(summary.coversFullRange).toBe(true);
    expect(summary.average).toBeNull();
  });

  it("uses the newest kept row as the upper bound of the covered window", () => {
    const summary = temperatureSummary([sample(50, "2026-08-01 08:00:00"), sample(52, "2026-08-25 22:21:00")], TRUNCATED);

    expect(summary.scopeNote).toBe("ค่านี้ครอบคลุมเฉพาะ 1 ส.ค. 2569 08:00 ถึง 25 ส.ค. 2569 22:21");
  });
});
