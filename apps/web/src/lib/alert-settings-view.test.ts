import { describe, expect, it } from "vitest";
import {
  budgetWarning,
  clampMonthlyBudget,
  clampRenotifyHours,
  estimateCopy,
  formFromSettings,
  monthlyEstimate,
  parseForm,
  usageCopy,
  type AlertSettings,
  type BudgetUsage
} from "./alert-settings-view";

const settings: AlertSettings = { renotifyHours: 12, monthlyBudget: 200, updatedAt: null, source: "environment" };

describe("form round-trip", () => {
  it("fills the form from the settings and parses it back", () => {
    const form = formFromSettings(settings);
    expect(form).toEqual({ renotifyHours: "12", monthlyBudget: "200" });
    expect(parseForm(form)).toEqual({ renotifyHours: 12, monthlyBudget: 200 });
  });

  it("returns null for an empty or non-numeric field, so a typo cannot reset the other", () => {
    expect(parseForm({ renotifyHours: "", monthlyBudget: "200" })).toEqual({ renotifyHours: null, monthlyBudget: 200 });
    expect(parseForm({ renotifyHours: "abc", monthlyBudget: "200" })).toEqual({ renotifyHours: null, monthlyBudget: 200 });
    expect(parseForm({ renotifyHours: " 6 ", monthlyBudget: "" })).toEqual({ renotifyHours: 6, monthlyBudget: null });
  });
});

describe("clamping", () => {
  it("keeps the floor inside a day and a week", () => {
    expect(clampRenotifyHours(0)).toBe(1);
    expect(clampRenotifyHours(500)).toBe(168);
    expect(clampRenotifyHours(6.4)).toBe(6);
  });

  it("keeps the cap inside what a plan could allow", () => {
    expect(clampMonthlyBudget(-5)).toBe(0);
    expect(clampMonthlyBudget(5000)).toBe(1000);
    expect(clampMonthlyBudget(200.6)).toBe(201);
  });
});

describe("monthlyEstimate", () => {
  it("turns a floor into messages per month for two channels", () => {
    // 24/12 = 2 per channel per day, × 2 channels × 30 days.
    expect(monthlyEstimate(12)).toBe(120);
    expect(monthlyEstimate(1)).toBe(1440);
    expect(monthlyEstimate(24)).toBe(60);
    expect(monthlyEstimate(0)).toBe(0);
  });

  it("says it in a sentence the owner can judge", () => {
    expect(estimateCopy(12)).toContain("120 ข้อความ/เดือน");
    expect(estimateCopy(12)).toContain("4 ข้อความ/วัน");
  });
});

describe("budgetWarning", () => {
  it("warns when the floor would spend the cap before the month ends", () => {
    expect(budgetWarning(1, 200)).toContain("เกินเพดาน");
    expect(budgetWarning(12, 200)).toBeNull();
  });

  it("treats a cap of zero as 'no alerts at all', not as unlimited", () => {
    expect(budgetWarning(12, 0)).toContain("ไม่ส่งการแจ้งเตือนเลย");
  });
});

describe("usageCopy", () => {
  const base: BudgetUsage = { month: "2026-11", used: 17, cap: 200, remaining: 183 };

  it("reports what is left in the owner's words", () => {
    const line = usageCopy(base);
    expect(line.tone).toBe("ok");
    expect(line.text).toContain("17 จาก 200");
    expect(line.text).toContain("เหลือ 183");
  });

  it("warns near the cap and says so when it is spent", () => {
    expect(usageCopy({ ...base, used: 170, remaining: 30 }).tone).toBe("warn");
    const spent = usageCopy({ ...base, used: 200, remaining: 0 });
    expect(spent.tone).toBe("spent");
    expect(spent.text).toContain("เพดานเต็มแล้ว");
  });
});
