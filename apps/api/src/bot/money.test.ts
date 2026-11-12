import { describe, expect, it } from "vitest";
import { bahtOnly, formatBaht } from "./money";

describe("bahtOnly", () => {
  it("collapses the conversion the model writes out loud", () => {
    expect(bahtOnly("รายได้ 96,000 สตางค์ = 960 บาท")).toBe("รายได้ 960 บาท");
    expect(bahtOnly("381,000 สตางค์ = 3,810 บาท")).toBe("3,810 บาท");
  });

  it("converts a satang figure that stands alone", () => {
    expect(bahtOnly("ยอดชำระ 477,000 สตางค์")).toBe("ยอดชำระ 4,770 บาท");
    expect(bahtOnly("0.5 สตางค์")).toBe("0.01 บาท");
  });

  it("handles several amounts in one sentence, in order", () => {
    const text = "รอบซัก 17 รอบ · รายได้ 96,000 สตางค์ = 960 บาท · รวม 477,000 สตางค์ = 4,770 บาท";
    expect(bahtOnly(text)).toBe("รอบซัก 17 รอบ · รายได้ 960 บาท · รวม 4,770 บาท");
  });

  it("leaves baht alone", () => {
    expect(bahtOnly("รายได้ 4,770 บาท")).toBe("รายได้ 4,770 บาท");
    expect(bahtOnly("ไม่มีข้อมูลรายได้")).toBe("ไม่มีข้อมูลรายได้");
  });

  it("does not convert the baht half of a pair twice", () => {
    expect(bahtOnly("96,000 สตางค์ = 960 บาท")).not.toContain("สตางค์");
    expect(bahtOnly("96,000 สตางค์ = 960 บาท")).toBe("960 บาท");
  });
});

describe("formatBaht", () => {
  it("drops the decimals when the amount is whole", () => {
    expect(formatBaht(960)).toBe("960 บาท");
    expect(formatBaht(4770)).toBe("4,770 บาท");
  });

  it("keeps two decimals when it is not", () => {
    expect(formatBaht(960.5)).toBe("960.50 บาท");
    expect(formatBaht(0.005)).toBe("0.01 บาท");
  });
});
