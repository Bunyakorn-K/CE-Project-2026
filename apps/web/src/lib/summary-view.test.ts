import { describe, expect, it } from "vitest";
import { summaryAvailabilityLabel, summarySourceLabel, summaryView } from "./summary-view";

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

  it("keeps an unrecognised availability value visible rather than dropping it", () => {
    expect(summaryAvailabilityLabel("degraded")).toContain("degraded");
  });
});