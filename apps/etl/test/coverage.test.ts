import { describe, expect, it } from "vitest";
import {
  classifyCoverage,
  eachDay,
  needsAttention,
  summarise,
  type CoverageSummary
} from "../src/coverage.js";

/**
 * The verdict this module exists to produce.
 *
 * Every one of these cases was measured against production on 2026-10-02: IRIS
 * holds 424 usage rows dated before the warehouse's first business day and not
 * one carries a `started_at`, because IRIS began populating that column on
 * 2026-07-22. A count-only comparison reads those as 68 missing days.
 */
describe("day classification", () => {
  it("walks an inclusive range", () => {
    expect(eachDay("2026-07-22", "2026-07-25")).toEqual([
      "2026-07-22",
      "2026-07-23",
      "2026-07-24",
      "2026-07-25"
    ]);
  });

  it("returns a single day when from equals to", () => {
    expect(eachDay("2026-07-27", "2026-07-27")).toEqual(["2026-07-27"]);
  });

  // A reversed range silently producing an empty list would make an audit
  // report "everything is fine" for a window that was never examined.
  it("refuses a reversed range rather than reporting nothing missing", () => {
    expect(() => eachDay("2026-07-25", "2026-07-22")).toThrow(/precedes/);
  });

  it("rejects a malformed day rather than guessing", () => {
    expect(() => eachDay("22/07/2026", "2026-07-25")).toThrow(/YYYY-MM-DD/);
  });
});

describe("a day is classified by asking the source, not by counting the warehouse", () => {
  const classify = (over: Partial<Parameters<typeof classifyCoverage>[0]> = {}) =>
    classifyCoverage({
      from: "2026-04-28",
      to: "2026-04-30",
      warehouse: {},
      source: {},
      sourceWithBusinessTimestamp: {},
      ...over
    });

  it("calls a day with warehouse rows present", () => {
    const s = classify({ warehouse: { "2026-04-28": 5 } });
    expect(s.days[0].verdict).toBe("present");
    expect(needsAttention(s)).toBe(false);
  });

  // THE case. The source has five rows for the day, none of which carry the
  // business timestamp, so the day is absent from the warehouse AND
  // unrecoverable. Reporting it as missing is what turns a source-schema fact
  // into "five days of lost revenue".
  it("calls a day with source rows but no business timestamp NOT missing", () => {
    const s = classify({
      source: { "2026-04-28": 5 },
      sourceWithBusinessTimestamp: { "2026-04-28": 0 }
    });
    expect(s.days[0].verdict).toBe("no_business_timestamp");
    expect(s.recoverable).toEqual([]);
    expect(s.noBusinessTimestamp).toEqual(["2026-04-28"]);
    expect(needsAttention(s)).toBe(false);
  });

  // The only verdict that means "a reload would actually put a row here".
  it("calls a day recoverable only when the source carries the business timestamp", () => {
    const s = classify({
      source: { "2026-04-28": 9 },
      sourceWithBusinessTimestamp: { "2026-04-28": 3 }
    });
    expect(s.days[0].verdict).toBe("recoverable");
    expect(s.recoverable).toEqual(["2026-04-28"]);
    expect(needsAttention(s)).toBe(true);
  });

  it("calls a day neither side has a true gap", () => {
    const s = classify();
    expect(s.days[0].verdict).toBe("absent_from_source");
    expect(s.absentFromSource).toEqual(["2026-04-28", "2026-04-29", "2026-04-30"]);
    expect(needsAttention(s)).toBe(false);
  });

  // The measured shape: the business timestamp count must never exceed the
  // source row count, or a query bug upstream would invent recoverable days.
  it("treats the warehouse as authoritative for a day it already has", () => {
    const s = classify({
      warehouse: { "2026-04-28": 2 },
      source: { "2026-04-28": 2 },
      sourceWithBusinessTimestamp: { "2026-04-28": 2 }
    });
    expect(s.days[0].verdict).toBe("present");
    expect(s.days[0].warehouseRows).toBe(2);
  });

  it("keeps the three failure classes in separate buckets", () => {
    const s = classify({
      from: "2026-04-28",
      to: "2026-04-30",
      warehouse: { "2026-04-28": 1 },
      source: { "2026-04-29": 3 },
      sourceWithBusinessTimestamp: { "2026-04-30": 4 }
    });
    expect(s.recoverable).toEqual(["2026-04-30"]);
    expect(s.noBusinessTimestamp).toEqual(["2026-04-29"]);
    // 04-28 is present, so it is in no bucket at all.
    expect(s.absentFromSource).toEqual([]);
  });
});

describe("the summary states the distinction rather than one scary number", () => {
  const summary: CoverageSummary = classifyCoverage({
    from: "2026-04-28",
    to: "2026-04-30",
    warehouse: { "2026-04-28": 4 },
    source: { "2026-04-29": 6 },
    sourceWithBusinessTimestamp: {}
  });

  it("counts the three classes separately", () => {
    const line = summarise(summary);
    expect(line).toContain("1/3 days present");
    expect(line).toContain("0 recoverable");
    expect(line).toContain("1 without a business timestamp");
    // 04-30 is on neither side, so it is a true gap and lands in its own bucket
    // rather than being folded in with the day that was never a business day.
    expect(line).toContain("1 absent from source");
  });

  // A summary reading "1 missing" would be true of the calendar and false of
  // the data. The wording is the guard.
  it("never calls a day without a business timestamp 'missing'", () => {
    expect(summarise(summary)).not.toMatch(/missing/i);
  });

  it("names the window it examined", () => {
    expect(summarise(summary)).toContain("2026-04-28 .. 2026-04-30");
  });
});