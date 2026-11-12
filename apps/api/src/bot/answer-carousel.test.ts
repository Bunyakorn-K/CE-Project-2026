import { describe, expect, it } from "vitest";
import { branchSectionCount, buildBranchCarousel, carouselAltText, parseSections } from "./answer-flex";

const TWO_BRANCHES = `ภาพรวมวันนี้ (2026-11-12) — ทุกสาขา

### สาขา: about you.wash & dry แม่โจ้ - ตลาดโซนเหลือง
รอบซัก: 17 รอบ
เวลาเฉลี่ย/รอบ: 31.41 นาที
รายได้: 960 บาท

### สาขา: about you.wash & dry แม่โจ้ - หลิ่งมื่น
รอบซัก: 64 รอบ
เวลาเฉลี่ย/รอบ: 32.67 นาที
รายได้: 3,810 บาท

### สรุปรวม
รอบซักทั้งหมด: 81 รอบ
รายได้ทั้งหมด: 4,770 บาท`;

describe("parseSections", () => {
  it("lifts one section per branch and keeps the summary apart", () => {
    const sections = parseSections(TWO_BRANCHES);
    const titles = sections.map((section) => section.title);
    expect(titles).toContain("about you.wash & dry แม่โจ้ - ตลาดโซนเหลือง");
    expect(titles).toContain("about you.wash & dry แม่โจ้ - หลิ่งมื่น");
    expect(titles).toContain("สรุปรวม");
    expect(branchSectionCount(sections)).toBe(3);
  });

  it("puts the numbers under the branch they belong to", () => {
    const sections = parseSections(TWO_BRANCHES);
    const yellow = sections.find((section) => section.title?.includes("ตลาดโซนเหลือง"));
    expect(yellow?.rows.map((row) => `${row.label}: ${row.value}`)).toEqual([
      "รอบซัก: 17 รอบ",
      "เวลาเฉลี่ย/รอบ: 31.41 นาที",
      "รายได้: 960 บาท"
    ]);
  });

  it("does not invent a branch from prose", () => {
    const sections = parseSections("วันนี้มี 81 รอบ จาก 2 สาขา\nรายได้รวม 4,770 บาท");
    expect(branchSectionCount(sections)).toBe(0);
  });
});

describe("buildBranchCarousel", () => {
  it("returns a carousel with one bubble per branch", () => {
    const carousel = buildBranchCarousel(parseSections(TWO_BRANCHES), { accent: "#1f6feb" }) as unknown as {
      type: string;
      contents: { type: string; size: string; header?: { contents: { text: string }[] } }[];
    };
    expect(carousel.type).toBe("carousel");
    expect(carousel.contents).toHaveLength(3);
    expect(carousel.contents.every((bubble) => bubble.type === "bubble" && bubble.size === "kilo")).toBe(true);
    expect(carousel.contents[0].header?.contents[0].text).toBe("about you.wash & dry แม่โจ้ - ตลาดโซนเหลือง");
  });

  it("puts the feedback buttons on the last card only", () => {
    const carousel = buildBranchCarousel(parseSections(TWO_BRANCHES), { accent: "#1f6feb", feedbackFor: "turn-1" }) as unknown as {
      contents: { body: { contents: { type: string; contents?: { type: string; action?: { data: string } }[] }[] } }[];
    };
    const postbacks = carousel.contents.map((bubble) =>
      JSON.stringify(bubble.body).match(/fb:(up|down):turn-1/g) ?? []
    );
    expect(postbacks.at(-1)).toHaveLength(2);
    expect(postbacks.slice(0, -1).flat()).toHaveLength(0);
  });

  it("refuses a single branch — that is a card, not a carousel", () => {
    const one = `### สาขา: หลิ่งมื่น\nรอบซัก: 64 รอบ`;
    expect(buildBranchCarousel(parseSections(one), {})).toBeNull();
  });

  it("caps at twelve bubbles", () => {
    const many = Array.from({ length: 15 }, (_, index) => `### สาขา: สาขา ${index + 1}\nรอบซัก: ${index} รอบ`).join("\n\n");
    const carousel = buildBranchCarousel(parseSections(many), {}) as unknown as { contents: unknown[] };
    expect(carousel.contents).toHaveLength(12);
  });
});

describe("carouselAltText", () => {
  it("names the branches and their first number", () => {
    const alt = carouselAltText(parseSections(TWO_BRANCHES));
    expect(alt).toContain("ตลาดโซนเหลือง (รอบซัก 17 รอบ)");
    expect(alt).toContain("หลิ่งมื่น (รอบซัก 64 รอบ)");
  });
});
