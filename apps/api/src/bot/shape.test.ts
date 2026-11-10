import { describe, expect, it } from "vitest";
import { MAX_PART_CHARS, MAX_PARTS, TRUNCATION_NOTE, shapeAnswer } from "./shape";

const long = (chars: number, unit = "ข้อมูลร้านซักรีด ") =>
  Array.from({ length: Math.ceil(chars / unit.length) }, () => unit).join("").slice(0, chars);

describe("shapeAnswer", () => {
  it("leaves a short answer in one part", () => {
    const shaped = shapeAnswer("ภาพรวมวันนี้\nรายได้: 1,240 บาท");
    expect(shaped.parts).toHaveLength(1);
    expect(shaped.truncated).toBe(false);
  });

  it("splits an over-long answer at a paragraph break, not mid-sentence", () => {
    const first = long(600);
    const second = long(600);
    const shaped = shapeAnswer(`${first}\n\n${second}`);
    expect(shaped.parts).toHaveLength(2);
    // The boundary is the paragraph the author wrote, so neither part is cut.
    expect(shaped.parts[0]).toBe(first.trim());
    expect(shaped.parts[1]).toBe(second.trim());
    expect(shaped.truncated).toBe(false);
  });

  it("keeps every part inside the limit and marks the one it cut", () => {
    const shaped = shapeAnswer(long(4000));
    expect(shaped.parts).toHaveLength(MAX_PARTS);
    for (const part of shaped.parts) expect(part.length).toBeLessThanOrEqual(MAX_PART_CHARS);
    expect(shaped.truncated).toBe(true);
    // An answer that stops mid-thought without a marker reads as a broken bot.
    expect(shaped.parts[MAX_PARTS - 1].endsWith("…")).toBe(true);
  });

  it("stops at a sentence end inside a paragraph that is too long", () => {
    const sentence = `${long(300)}. `;
    const shaped = shapeAnswer(sentence.repeat(4).trim());
    for (const part of shaped.parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_PART_CHARS);
      expect(part.endsWith("…") || /[.!?]$/.test(part) || part.length < MAX_PART_CHARS).toBe(true);
    }
  });

  it("returns nothing for an empty answer rather than an empty message", () => {
    expect(shapeAnswer("   \n\n ").parts).toEqual([]);
  });

  it("keeps a bullet list together when it fits", () => {
    const list = ["- รอบซัก: 38", "- เวลาเฉลี่ย: 34.8", "- เครื่องว่าง: 12"].join("\n");
    const shaped = shapeAnswer(`ภาพรวมวันนี้\n\n${list}`);
    expect(shaped.parts).toHaveLength(1);
    expect(shaped.parts[0]).toContain("- เครื่องว่าง: 12");
  });

  it("has a truncation note the caller can append", () => {
    expect(TRUNCATION_NOTE).toContain("ถามเจาะจงขึ้น");
  });
});
