import { describe, expect, it } from "vitest";
import { hourRangeLabel, offPeakEmptyReason, weekdayLabel } from "./offpeak-view";

describe("hourRangeLabel", () => {
  it("renders the bucket as a start-end hour range", () => {
    expect(hourRangeLabel(3)).toBe("03:00–04:00");
    expect(hourRangeLabel(14)).toBe("14:00–15:00");
  });

  it("wraps midnight rather than printing hour 24", () => {
    expect(hourRangeLabel(23)).toBe("23:00–00:00");
  });

  it("pads single-digit hours", () => {
    expect(hourRangeLabel(0)).toBe("00:00–01:00");
    expect(hourRangeLabel(9)).toBe("09:00–10:00");
  });

  it("says unknown rather than formatting an impossible hour", () => {
    expect(hourRangeLabel(24)).toBe("ไม่ทราบ");
    expect(hourRangeLabel(-1)).toBe("ไม่ทราบ");
    expect(hourRangeLabel(3.5)).toBe("ไม่ทราบ");
  });
});

describe("weekdayLabel", () => {
  it("renders the Thai weekday from the 1-based day number", () => {
    expect(weekdayLabel("Mon", 1)).toBe("จันทร์");
    expect(weekdayLabel("Sun", 7)).toBe("อาทิตย์");
  });

  it("falls back to the server label for a day number it does not know", () => {
    expect(weekdayLabel("Tue", 9)).toBe("Tue");
  });
});

describe("offPeakEmptyReason", () => {
  it("distinguishes too little data from a window with no match", () => {
    const tooLittle = offPeakEmptyReason({ minCycles: 10, percentile: 25, eligibleBuckets: 0, returnedBuckets: 0 });
    const noMatch = offPeakEmptyReason({ minCycles: 10, percentile: 25, eligibleBuckets: 40, returnedBuckets: 0 });
    expect(tooLittle).not.toBe(noMatch);
  });

  it("names the minimum when no bucket cleared it", () => {
    expect(offPeakEmptyReason({ minCycles: 10, percentile: 25, eligibleBuckets: 0, returnedBuckets: 0 })).toContain("10");
  });

  it("does not blame thin data when buckets were eligible", () => {
    const reason = offPeakEmptyReason({ minCycles: 10, percentile: 25, eligibleBuckets: 40, returnedBuckets: 0 });
    expect(reason).not.toContain("ข้อมูลในช่วงนี้น้อยเกินกว่าจะสรุปได้");
  });

  it("still says something when the response carried no rules", () => {
    expect(offPeakEmptyReason(undefined).length).toBeGreaterThan(0);
  });
});
