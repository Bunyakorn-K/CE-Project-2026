import { describe, expect, it } from "vitest";
import {
  ANSWER_ALT_LIMIT,
  answerAltText,
  buildAnswerFlex,
  looksStructured,
  parseAnswer,
  stripMarkdown
} from "./answer-flex";

describe("stripMarkdown", () => {
  it("removes the markers a LINE text message would show literally", () => {
    expect(stripMarkdown("**รายได้**: 1,200 บาท")).toBe("รายได้: 1,200 บาท");
    expect(stripMarkdown("### สรุป")).toBe("สรุป");
    expect(stripMarkdown("- เครื่อง 3 หยุด")).toBe("เครื่อง 3 หยุด");
    expect(stripMarkdown("`ค่า`")).toBe("ค่า");
  });
});

describe("parseAnswer", () => {
  it("reads a heading, label rows and bullets out of a model answer", () => {
    const parsed = parseAnswer(
      [
        "## ภาพรวมวันนี้",
        "",
        "**รายได้**: 1,240 บาท",
        "รอบซัก: 31 รอบ",
        "",
        "- เครื่อง 3 หยุดตั้งแต่ 09:20",
        "- 1. คิวรอ 4 คัน"
      ].join("\n")
    );

    expect(parsed.title).toBe("ภาพรวมวันนี้");
    expect(parsed.rows).toEqual([
      { label: "รายได้", value: "1,240 บาท" },
      { label: "รอบซัก", value: "31 รอบ" }
    ]);
    expect(parsed.bullets).toEqual(["เครื่อง 3 หยุดตั้งแต่ 09:20", "คิวรอ 4 คัน"]);
  });

  it("treats a short label with a colon as a row — Thai has no spaces to go by", () => {
    const parsed = parseAnswer("สาเหตุคือ: ปั๊มน้ำแรงดันตก จึงหยุดทำงานกลางรอบ");
    expect(parsed.rows).toEqual([
      { label: "สาเหตุคือ", value: "ปั๊มน้ำแรงดันตก จึงหยุดทำงานกลางรอบ" }
    ]);
  });

  it("leaves a paragraph alone even when it mentions a date and a number", () => {
    const parsed = parseAnswer(
      "ขอโทษครับ ข้อมูลที่ได้นะครับ สำหรับวันที่ 2026-07-01 ยังไม่มีข้อมูลเลย"
    );
    expect(parsed.rows).toEqual([]);
    expect(looksStructured(parsed)).toBe(false);
  });

  it("treats a second heading as text, because a card has one header", () => {
    const parsed = parseAnswer("## หัวข้อ\n\n- หนึ่ง\n\n## หมายเหตุ\nข้อความท้าย");
    expect(parsed.title).toBe("หัวข้อ");
    expect(parsed.outro.join(" ")).toContain("หมายเหตุ");
  });

  it("ignores rules, fences and blank lines", () => {
    const parsed = parseAnswer("---\n```\ncode\n```\n\n- รายการ");
    expect(parsed.bullets).toEqual(["รายการ"]);
    expect(parsed.intro).toEqual([]);
  });

  it("caps the rows and bullets at what a card can show", () => {
    const rows = Array.from({ length: 12 }, (_, index) => `ตัวเลข ${index}: ${index}`).join("\n");
    const bullets = Array.from({ length: 12 }, (_, index) => `- รายการ ${index}`).join("\n");
    const parsed = parseAnswer(`${rows}\n${bullets}`);
    expect(parsed.rows.length).toBeLessThanOrEqual(8);
    expect(parsed.bullets.length).toBeLessThanOrEqual(8);
  });

  it("is not structured when the answer is one plain sentence", () => {
    const parsed = parseAnswer("ครับ วันนี้ร้านเปิดปกติครับ");
    expect(looksStructured(parsed)).toBe(false);
    expect(buildAnswerFlex(parsed)).toBeNull();
  });
});

describe("buildAnswerFlex", () => {
  const parsed = parseAnswer(["## ภาพรวมวันนี้", "รายได้: 1,240 บาท", "รอบซัก: 31 รอบ", "- เครื่อง 3 หยุด"].join("\n"));

  it("puts the title in a coloured header and the rows in the body", () => {
    const bubble = buildAnswerFlex(parsed, { accent: "#2ea043" }) as {
      type: string;
      header: { backgroundColor: string; contents: { text: string }[] };
      body: { contents: { type: string; contents?: unknown[] }[] };
    };

    expect(bubble.type).toBe("bubble");
    expect(bubble.header.backgroundColor).toBe("#2ea043");
    expect(bubble.header.contents[0].text).toBe("ภาพรวมวันนี้");

    const boxes = bubble.body.contents.filter((component) => component.type === "box");
    // Two label/value rows, then the bullet.
    expect(boxes.length).toBe(3);
    for (const box of boxes) expect((box.contents ?? []).length).toBeGreaterThan(0);
  });

  it("carries nothing empty — an empty text component renders as a gap", () => {
    const bubble = buildAnswerFlex(parsed) as { body: { contents: { type: string; text?: string }[] } };
    for (const component of bubble.body.contents) {
      if (component.type === "text") expect((component.text ?? "").trim()).not.toBe("");
    }
  });

  it("never uses a spacer — LINE rejects one that is not first or last in a box", () => {
    // validate/push answered: "spacer must be the fist or last element of the box".
    // Every card carrying a spacer between rows was refused outright.
    expect(JSON.stringify(buildAnswerFlex(parsed))).not.toContain('"spacer"');
  });

  it("spaces rows with margins on the following component", () => {
    const bubble = buildAnswerFlex(parsed) as { body: { contents: { margin?: string }[] } };
    const margins = bubble.body.contents.map((component) => component.margin);
    expect(margins[0]).toBeUndefined();
    expect(margins.slice(1)).toContain("sm");
  });

  it("builds altText from the same parts and keeps it inside LINE's limit", () => {
    const alt = answerAltText(parsed);
    expect(alt).toContain("ภาพรวมวันนี้");
    expect(alt).toContain("รายได้: 1,240 บาท");
    expect(alt.length).toBeLessThanOrEqual(ANSWER_ALT_LIMIT);
  });

  it("truncates instead of letting LINE reject an oversized altText", () => {
    const long = parseAnswer(`## ${"หัวข้อ".repeat(40)}\n${"- " + "รายละเอียด".repeat(60)}`);
    const alt = answerAltText(long);
    expect(alt.length).toBeLessThanOrEqual(ANSWER_ALT_LIMIT);
    expect(alt.endsWith("…")).toBe(true);
  });
});
