import { describe, expect, it } from "vitest";
import { SIMULATED_NOTICE, stripProvenance } from "./provenance";

describe("stripProvenance", () => {
  it("removes the tool line the model appends", () => {
    const text = "รายได้วันนี้ 4,980 บาท\nรอบซัก 83 รอบ\n\nที่มา: get_revenue_daily, get_cycles_daily (real data)\nแหล่งข้อมูล: real";
    expect(stripProvenance(text)).toBe("รายได้วันนี้ 4,980 บาท\nรอบซัก 83 รอบ");
  });

  it("removes it in the other shapes the model uses", () => {
    expect(stripProvenance("- ที่มา: get_cycles_daily\nรอบซัก 10 รอบ")).toBe("รอบซัก 10 รอบ");
    expect(stripProvenance("รายได้ 100 บาท (real data)")).toBe("รายได้ 100 บาท");
    expect(stripProvenance("Source: get_revenue_daily")).toBe("");
  });

  it("keeps the warning that a simulated answer is simulated", () => {
    const text = "รายได้วันนี้ 4,980 บาท\nที่มา: get_revenue_daily (synthetic)";
    expect(stripProvenance(text)).toBe(`รายได้วันนี้ 4,980 บาท\n${SIMULATED_NOTICE}`);
  });

  it("does not repeat the warning once per line", () => {
    const text = "ที่มา: synthetic\nแหล่งข้อมูล: mixed";
    expect(stripProvenance(text)).toBe(SIMULATED_NOTICE);
  });

  it("leaves an answer about the shop untouched", () => {
    const text = "รอบซักวันนี้ 83 รอบ เฉลี่ย 33 นาที\nสาขาที่ดีที่สุด: หลิ่งมื่น";
    expect(stripProvenance(text)).toBe(text);
  });

  it("does not strip a sentence that merely mentions a source in prose", () => {
    const text = "ข้อมูลจากเครื่องซักผ้าล่าสุดเมื่อ 10 นาทีที่แล้ว";
    expect(stripProvenance(text)).toBe(text);
  });

  it("collapses the blank lines a removed line leaves", () => {
    expect(stripProvenance("ก\n\n\nข\n\nที่มา: get_x")).toBe("ก\n\nข");
  });
});
