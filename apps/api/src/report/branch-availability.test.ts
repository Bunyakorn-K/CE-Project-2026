import { describe, expect, it } from "vitest";
import {
  branchOpenState,
  effectiveAvailability,
  isUsableHours,
  localTimeInZone,
  resolveBranchOpenState,
  type Availability,
  type BranchHours
} from "./branch-availability";

/**
 * The production defect these tests exist for: on 2026-10-01 all 19 machines at
 * the real branch rendered `ไม่พร้อมใช้งาน` in red because the newest usage row
 * was 52 minutes old — the branch was shut, and every machine was fine.
 *
 * Two guards carry the weight, and each was verified to FAIL against
 * deliberately broken code:
 *
 * - an unusable schedule must resolve to `unknown` and leave freshness
 *   untouched. Widening `effectiveAvailability` to also return "closed" for
 *   `unknown` fails `unknown schedule never silences a machine fault`.
 * - an open branch with no evidence must stay `unavailable`. Collapsing the
 *   function to `return "closed"` fails `open branch with no evidence is still
 *   a real fault`.
 */

const HOURS: BranchHours = { openMinute: 6 * 60, closeMinute: 22 * 60, openDays: [] };
const at = (iso: string) => new Date(iso);

describe("isUsableHours", () => {
  it("accepts an ordinary week", () => {
    expect(isUsableHours(HOURS)).toBe(true);
  });

  it("accepts a branch that trades past midnight", () => {
    expect(isUsableHours({ openMinute: 22 * 60, closeMinute: 2 * 60, openDays: [] })).toBe(true);
  });

  it("accepts closing at midnight", () => {
    expect(isUsableHours({ openMinute: 6 * 60, closeMinute: 1440, openDays: [] })).toBe(true);
  });

  it.each([
    ["absent", null],
    ["undefined", undefined]
  ])("rejects %s hours", (_label, value) => {
    expect(isUsableHours(value)).toBe(false);
  });

  it("rejects a zero-length window, which is a typo not a schedule", () => {
    expect(isUsableHours({ openMinute: 600, closeMinute: 600, openDays: [] })).toBe(false);
  });

  it.each([
    ["open past midnight", { openMinute: -1, closeMinute: 60, openDays: [] }],
    ["close past the last minute", { openMinute: 60, closeMinute: 1441, openDays: [] }],
    ["a fractional minute", { openMinute: 600.5, closeMinute: 700, openDays: [] }],
    ["a NaN minute", { openMinute: Number.NaN, closeMinute: 700, openDays: [] }]
  ])("rejects %s", (_label, hours) => {
    expect(isUsableHours(hours as BranchHours)).toBe(false);
  });

  it.each([
    ["weekday 0", [0]],
    ["weekday 8", [8]],
    ["a fractional weekday", [1.5]]
  ])("rejects %s", (_label, openDays) => {
    expect(isUsableHours({ openMinute: 60, closeMinute: 700, openDays } as BranchHours)).toBe(false);
  });
});

describe("branchOpenState", () => {
  it("reads a mid-morning minute as open", () => {
    expect(branchOpenState(HOURS, 9 * 60, 3)).toBe("open");
  });

  it("reads the closing minute as already closed, because close is exclusive", () => {
    // Otherwise a branch would report open for the whole minute it shuts.
    expect(branchOpenState(HOURS, 22 * 60, 3)).toBe("closed");
  });

  it("reads the opening minute as open", () => {
    expect(branchOpenState(HOURS, 6 * 60, 3)).toBe("open");
  });

  it("reads late night as closed — the production case", () => {
    expect(branchOpenState(HOURS, 22 * 60 + 30, 3)).toBe("closed");
  });

  it("treats an empty openDays as every day", () => {
    expect(branchOpenState(HOURS, 9 * 60, 7)).toBe("open");
  });

  it("reads a day the branch does not trade as closed", () => {
    const weekdaysOnly = { ...HOURS, openDays: [1, 2, 3, 4, 5] };
    expect(branchOpenState(weekdaysOnly, 9 * 60, 6)).toBe("closed");
    expect(branchOpenState(weekdaysOnly, 9 * 60, 5)).toBe("open");
  });

  describe("a branch that trades past midnight", () => {
    const late = { openMinute: 22 * 60, closeMinute: 2 * 60, openDays: [] };

    it("is open late in the evening", () => {
      expect(branchOpenState(late, 23 * 60, 3)).toBe("open");
    });

    it("is open after midnight, which a naive compare would call closed", () => {
      expect(branchOpenState(late, 60, 4)).toBe("open");
    });

    it("is closed in the middle of the afternoon", () => {
      expect(branchOpenState(late, 14 * 60, 3)).toBe("closed");
    });
  });

  it.each([
    ["null", null],
    ["an unparseable window", { openMinute: 600, closeMinute: 600, openDays: [] }]
  ])("resolves %s hours to unknown rather than closed", (_label, hours) => {
    // The safety rule: an unusable schedule must never be read as "shut",
    // because that would silence a real machine fault branch-wide.
    expect(branchOpenState(hours as BranchHours | null, 9 * 60, 3)).toBe("unknown");
  });
});

describe("effectiveAvailability", () => {
  it("replaces the evidence verdict with closed when the branch is shut", () => {
    expect(effectiveAvailability("unavailable", "closed")).toBe("closed");
    expect(effectiveAvailability("stale", "closed")).toBe("closed");
    expect(effectiveAvailability("fresh", "closed")).toBe("closed");
  });

  it("unknown schedule never silences a machine fault", () => {
    // SAFETY GUARD. Breaks if `unknown` is widened to return "closed".
    expect(effectiveAvailability("unavailable", "unknown")).toBe("unavailable");
  });

  it("open branch with no evidence is still a real fault", () => {
    // SAFETY GUARD. Breaks if the function collapses to `return "closed"`.
    expect(effectiveAvailability("unavailable", "open")).toBe("unavailable");
  });

  it.each([
    ["fresh", "fresh"],
    ["stale", "stale"],
    ["unavailable", "unavailable"]
  ] as [Availability, Availability][])(
    "an open or unknown branch passes %s through untouched",
    (freshness) => {
      expect(effectiveAvailability(freshness, "open")).toBe(freshness);
      expect(effectiveAvailability(freshness, "unknown")).toBe(freshness);
    }
  );
});

describe("localTimeInZone", () => {
  it("reads Bangkok local time, not the server's", () => {
    // 18:00 UTC on Thu Oct 1 is 01:00 on FRI Oct 2 in Bangkok (UTC+7), so the
    // weekday must roll over with the clock. Asserting Thursday here would
    // pass on the minute and still hide a timezone bug that never rolls.
    const local = localTimeInZone("Asia/Bangkok", at("2026-10-01T18:00:00Z"));
    expect(local).toEqual({ minute: 60, isoWeekday: 5 });
  });

  it("reads midnight as hour zero, not hour twenty-four", () => {
    // Some ICU versions render midnight as "24" under hour12: false.
    const local = localTimeInZone("Asia/Bangkok", at("2026-10-01T17:00:00Z"));
    expect(local?.minute).toBe(0);
  });

  it("returns null for an unknown zone so it is never read as closed", () => {
    expect(localTimeInZone("Not/AZone", at("2026-10-01T18:00:00Z"))).toBeNull();
  });
});

describe("resolveBranchOpenState", () => {
  it("reports the real branch closed at 22:30 local", () => {
    // 15:30 UTC = 22:30 Bangkok. This is the production symptom.
    const state = resolveBranchOpenState(HOURS, "Asia/Bangkok", at("2026-10-01T15:30:00Z"));
    expect(state).toBe("closed");
  });

  it("reports the same branch open at 09:00 local", () => {
    expect(resolveBranchOpenState(HOURS, "Asia/Bangkok", at("2026-10-01T02:00:00Z"))).toBe("open");
  });

  it("is unknown when the timezone is unusable, even with perfect hours", () => {
    expect(resolveBranchOpenState(HOURS, "Not/AZone", at("2026-10-01T15:30:00Z"))).toBe("unknown");
  });

  it("is unknown when no hours are provisioned yet", () => {
    expect(resolveBranchOpenState(null, "Asia/Bangkok", at("2026-10-01T02:00:00Z"))).toBe("unknown");
  });
});

describe("with hours not yet provisioned", () => {
  it("degrades to today's exact behaviour for every freshness value", () => {
    // The mechanism ships empty, so this is the state production is in now.
    const state = resolveBranchOpenState(null, "Asia/Bangkok", at("2026-10-01T15:30:00Z"));
    expect(state).toBe("unknown");
    for (const freshness of ["fresh", "stale", "unavailable"] as Availability[]) {
      expect(effectiveAvailability(freshness, state)).toBe(freshness);
    }
  });
});