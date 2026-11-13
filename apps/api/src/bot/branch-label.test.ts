import { describe, expect, it } from "vitest";
import { QUICK_REPLY_LABEL_MAX, shortBranchLabel, shortBranchLabels } from "./branch-label";

const YELLOW = "about you.wash & dry แม่โจ้ - ตลาดโซนเหลือง";
const LING = "about you.wash & dry แม่โจ้ - หลิ่งมื่น";

describe("shortBranchLabel", () => {
  it("keeps the part that tells the branch apart", () => {
    expect(shortBranchLabel(YELLOW)).toBe("ตลาดโซนเหลือง");
    expect(shortBranchLabel(LING)).toBe("หลิ่งมื่น");
  });

  it("cuts from the left, so the distinguishing words survive", () => {
    const long = "about you.wash & dry แม่โจ้ - สาขาตลาดโซนเหลืองประตูทางเข้า";
    const label = shortBranchLabel(long);
    expect(label.length).toBeLessThanOrEqual(QUICK_REPLY_LABEL_MAX);
    expect(label.startsWith("…")).toBe(true);
    expect(label.endsWith("ประตูทางเข้า")).toBe(true);
  });

  it("handles a name with no separator at all", () => {
    expect(shortBranchLabel("หลิ่งมื่น")).toBe("หลิ่งมื่น");
  });
});

describe("shortBranchLabels", () => {
  it("gives two branches with the same prefix different labels", () => {
    // The production defect: both buttons read "about you.wash & dry".
    const labels = shortBranchLabels([YELLOW, LING]);
    expect(labels).toEqual(["ตลาดโซนเหลือง", "หลิ่งมื่น"]);
    expect(new Set(labels).size).toBe(2);
  });

  it("widens to another segment when the tails collide", () => {
    const labels = shortBranchLabels([
      "about you.wash & dry แม่โจ้ - โซน A",
      "about you.wash & dry ปากเกร็ด - โซน A"
    ]);
    expect(new Set(labels).size).toBe(2);
    expect(labels.every((label) => label.length <= QUICK_REPLY_LABEL_MAX)).toBe(true);
  });

  it("still separates two branches that share a whole name", () => {
    const labels = shortBranchLabels([LING, LING]);
    expect(new Set(labels).size).toBe(2);
    expect(labels[0]).toBe("หลิ่งมื่น");
    expect(labels[1]).not.toBe(labels[0]);
  });

  it("never returns a label LINE would cut again", () => {
    const labels = shortBranchLabels([
      "about you.wash & dry แม่โจ้ - ตลาดโซนเหลือง",
      "about you.wash & dry แม่โจ้ - หลิ่งมื่น",
      "about you.wash & dry เชียงใหม่ - นิมมานเหมินท์ซอยเจ็ด"
    ]);
    expect(labels.every((label) => label.length <= QUICK_REPLY_LABEL_MAX)).toBe(true);
    expect(new Set(labels).size).toBe(3);
  });

  it("returns nothing for nothing", () => {
    expect(shortBranchLabels([])).toEqual([]);
  });
});
