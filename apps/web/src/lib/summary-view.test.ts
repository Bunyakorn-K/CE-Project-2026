import { describe, expect, it } from "vitest";
import { summaryAvailabilityLabel, summarySegments, summarySourceLabel, summaryView } from "./summary-view";

describe("summaryView", () => {
  it("renders the server sentence when the window has usage rows", () => {
    expect(summaryView({ summary: "รอบรายงานนี้มี 1 รอบ จาก 1 เครื่อง.", usageRowsInRange: 3 })).toEqual({
      kind: "text",
      text: "รอบรายงานนี้มี 1 รอบ จาก 1 เครื่อง."
    });
  });

  it("suppresses the sentence over an empty window", () => {
    // "0 cycles from 0 machines" is a sentence about a period nobody measured.
    const view = summaryView({ summary: "รอบรายงานนี้มี 0 รอบ จาก 0 เครื่อง.", usageRowsInRange: 0 });
    expect(view.kind).toBe("hidden");
  });

  it("keeps the sentence when presence is unknown, not empty", () => {
    // The demo/IRIS path cannot report a usage-row count. The server still
    // computed the sentence from a real source, so hiding it would throw away a
    // genuine answer and call it an empty window.
    expect(summaryView({ summary: "สรุปจาก IRIS", usageRowsInRange: null }).kind).toBe("text");
  });

  it("suppresses a blank sentence and says why", () => {
    for (const summary of [null, undefined, "", "   "]) {
      expect(summaryView({ summary, usageRowsInRange: 5 })).toEqual({
        kind: "hidden",
        reason: "ยังไม่มีสรุปสำหรับช่วงวันที่ที่เลือก"
      });
    }
  });

  it("still suppresses a blank sentence over an empty window, and blames the window", () => {
    expect(summaryView({ summary: "", usageRowsInRange: 0 }).kind).toBe("hidden");
  });
});

describe("summarySourceLabel", () => {
  it("names ClickHouse, the demo client, and the two IRIS contract names", () => {
    expect(summarySourceLabel("clickhouse")).toContain("ClickHouse");
    expect(summarySourceLabel("demo")).toContain("Demo");
    expect(summarySourceLabel("postgres")).toContain("IRIS");
    expect(summarySourceLabel("durable-object")).toContain("IRIS");
  });

  it("never labels an unrecognised source as real data", () => {
    expect(summarySourceLabel(null)).toContain("ไม่ทราบ");
    expect(summarySourceLabel("mart-prod-replica")).toContain("ไม่ทราบ");
  });
});

describe("summaryAvailabilityLabel", () => {
  it("distinguishes usage-derived state from available state", () => {
    expect(summaryAvailabilityLabel("usage-derived")).toContain("live telemetry");
    expect(summaryAvailabilityLabel("available")).not.toContain("live telemetry");
  });

  it("keeps an unrecognised availability visible rather than dropping it", () => {
    // The label must still SAY something went unrecognised — silently falling
    // back to "พร้อมใช้งาน" would read as healthy. What it must not do is
    // embed the server's own English string in the Thai sentence, which is why
    // this asserts a Thai unknown-state rather than the raw value.
    const label = summaryAvailabilityLabel("degraded");

    expect(label).not.toBe(summaryAvailabilityLabel("available"));
    expect(label).not.toBe(summaryAvailabilityLabel("usage-derived"));
    expect(label).not.toContain("degraded");
    expect(label).toMatch(/ไม่ทราบ/);
  });
});
describe("summarySegments", () => {
  const sentence = "รอบรายงานนี้มี 624 รอบ จาก 18 เครื่อง · ยอดชำระสำเร็จ ฿33,540.00 · มี 3 รายการที่ต้องติดตาม.";

  it("marks every measurement and nothing else", () => {
    const measured = summarySegments(sentence).filter((segment) => segment.tone !== "plain").map((segment) => segment.text);
    expect(measured).toEqual(["624 รอบ", "18 เครื่อง", "฿33,540.00", "3 รายการ"]);
  });

  it("keeps the sentence readable when the parts are joined again", () => {
    expect(summarySegments(sentence).map((segment) => segment.text).join("")).toBe(sentence);
  });

  it("treats a number in a problem fragment as attention rather than a total", () => {
    const segment = summarySegments("ข้อมูลสดไม่พร้อม 2 เครื่อง").find((part) => part.text === "2 เครื่อง");
    expect(segment?.tone).toBe("attention");
  });

  it("does not style a bare number with no unit", () => {
    const plain = summarySegments("รอบรายงานนี้มี 624 จากทุกสาขา").every((segment) => segment.tone === "plain");
    expect(plain).toBe(true);
  });
});
