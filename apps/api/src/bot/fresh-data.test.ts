import { describe, expect, it } from "vitest";
import { FRESH_DATA_NUDGE, needsFreshNumbers } from "./fresh-data";

describe("needsFreshNumbers", () => {
  it("is true for the questions that were answered from memory", () => {
    // The production case: one step, zero tool calls, figures from a card 2.5 h old.
    expect(needsFreshNumbers("สาขาหลิ่งมื่น ภาพรวมวันนี้")).toBe(true);
    expect(needsFreshNumbers("รายได้วันนี้เท่าไหร่")).toBe(true);
    expect(needsFreshNumbers("เครื่องไหนมีปัญหาบ้าง")).toBe(true);
    expect(needsFreshNumbers("เมื่อวานขายได้กี่รอบ")).toBe(true);
  });

  it("is false for a thank-you or a greeting, which has no figures to check", () => {
    expect(needsFreshNumbers("ขอบคุณครับ")).toBe(false);
    expect(needsFreshNumbers("สวัสดี")).toBe(false);
    expect(needsFreshNumbers("   ")).toBe(false);
  });

  it("says why the numbers have to be re-measured", () => {
    // A bare "use a tool" is not enough: the model believed it was being consistent.
    expect(FRESH_DATA_NUDGE).toContain("ยังไม่ได้เรียกเครื่องมือ");
    expect(FRESH_DATA_NUDGE).toContain("ห้ามใช้ความจำแทนการวัด");
  });
});
