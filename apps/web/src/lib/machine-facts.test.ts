import { describe, expect, it } from "vitest";
import { machineCycleFacts, machineFreshnessRow, machineFloorGroups, machineFloorCycles } from "./machine-facts";

/**
 * The Digital Twin card used to render "ไม่มีแถว usage" ("no usage rows") for
 * any machine whose cycle count was not positive. The API has since learned to
 * distinguish three cases — usage rows exist and none reached a counted state,
 * genuinely no usage rows, and a source with no usage-row concept at all — and
 * this is where those must stay distinct in the interface.
 */
describe("machineCycleFacts", () => {
  it("shows a real zero, not unavailability, when usage rows exist but none counted", () => {
    const facts = machineCycleFacts({ cycleCount: 0, cycleCountSource: "usage_row" });

    // The regression: a busy machine whose rows are all pending_payment was
    // reported to the technician as having no usage at all.
    expect(facts.value).toBe("0");
    expect(facts.source).toBe("นับจากแถว usage");
    expect(facts.source).not.toContain("ไม่มีแถว");
  });

  it("says there is no usage only when the source reported zero usage rows", () => {
    const facts = machineCycleFacts({ cycleCount: null, cycleCountSource: "unavailable" });

    expect(facts.value).toBe("ไม่พร้อมใช้งาน");
    expect(facts.source).toBe("ไม่มีแถว usage ในช่วงนี้");
  });

  it("does not claim anything about usage rows when the source has no such concept", () => {
    // The demo/IRIS projection carries no usage-row field. Saying "no usage
    // rows" there would be the same overstatement, from a different direction.
    const facts = machineCycleFacts({ cycleCount: null, cycleCountSource: "unknown" });

    expect(facts.value).toBe("ไม่พร้อมใช้งาน");
    expect(facts.source).toBe("แหล่งข้อมูลนี้ไม่มีข้อมูลแถว usage");
    expect(facts.source).not.toContain("ไม่มีแถว usage ในช่วงนี้");
  });

  it("treats a missing source as unknown rather than defaulting to a usage claim", () => {
    const facts = machineCycleFacts({ cycleCount: 5 });

    expect(facts.source).toBe("ไม่ทราบที่มาของจำนวนรอบ");
  });

  it("never shows a number with no stated basis", () => {
    // A non-zero count without a usage-row source is a number the reader
    // cannot check. Refusing it is the same rule the demo dashboard follows
    // for usageRowsInRange.
    const facts = machineCycleFacts({ cycleCount: 7, cycleCountSource: undefined });

    expect(facts.value).toBe("ไม่พร้อมใช้งาน");
  });
});

describe("machineFreshnessRow", () => {
  it("returns the shared freshness label when the API reports freshness", () => {
    const row = machineFreshnessRow("stale");

    expect(row?.label).toBe("ข้อมูลไม่สด");
    expect(row?.className).toBe("status-pill--warning");
  });

  it("returns null when the payload carries no freshness at all", () => {
    // An older API build omits the field. Rendering nothing is correct;
    // asserting "fresh" would be a claim the payload never made.
    expect(machineFreshnessRow(undefined)).toBeNull();
    expect(machineFreshnessRow(null)).toBeNull();
  });

  it("shows an unrecognised freshness value rather than hiding it", () => {
    const row = machineFreshnessRow("quiescent");

    expect(row?.label).toContain("quiescent");
  });
});

describe("machineFloorGroups", () => {
  // "เครื่องทั้งหมด 24" over a grid of 21 cards is the kind of discrepancy that
  // makes an operator stop trusting every other total on the page.
  it("gives every machine a group so the grid renders what the total counts", () => {
    const groups = machineFloorGroups([
      { machineCode: "W1", machineKind: "washer" },
      { machineCode: "D1", machineKind: "dryer" },
      { machineCode: "X1", machineKind: "ironer" }
    ]);

    expect(groups.map((g) => g.title)).toEqual(["เครื่องซักผ้า", "เครื่องอบผ้า", "เครื่องประเภทอื่น"]);
    expect(groups.reduce((sum, g) => sum + g.machines.length, 0)).toBe(3);
  });

  it("labels the other group by its actual kinds rather than one invented name", () => {
    const groups = machineFloorGroups([
      { machineCode: "X1", machineKind: "ironer" },
      { machineCode: "X2", machineKind: "steamer" }
    ]);
    const other = groups.find((g) => g.title === "เครื่องประเภทอื่น");

    // `machineKindLabel` shows the verbatim kind, so a card that renders one
    // machine must not sit under a heading naming a different one.
    expect(other?.machines.map((m) => m.machineCode)).toEqual(["X1", "X2"]);
  });

  it("omits an empty group instead of rendering a heading with no cards", () => {
    const groups = machineFloorGroups([{ machineCode: "W1", machineKind: "washer" }]);

    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("เครื่องซักผ้า");
  });

  it("handles a machine with no kind at all without dropping it", () => {
    const groups = machineFloorGroups([{ machineCode: "U1", machineKind: "" }]);

    expect(groups.reduce((sum, g) => sum + g.machines.length, 0)).toBe(1);
  });
});

describe("machineFloorCycles", () => {
  it("states coverage instead of presenting one machine's cycles as the floor's", () => {
    // "รอบที่นับได้ 12" over a 40-machine floor reads as the floor total.
    expect(machineFloorCycles([{ cycleCount: 12 }, { cycleCount: null }, { cycleCount: null }])).toEqual({
      kind: "partial",
      value: "12",
      coverage: "นับได้ 1 จาก 3 เครื่อง"
    });
  });

  it("reports a full-coverage sum as the floor's own total", () => {
    expect(machineFloorCycles([{ cycleCount: 12 }, { cycleCount: 3 }])).toEqual({
      kind: "complete",
      value: "15",
      coverage: "ครบทั้ง 2 เครื่อง"
    });
  });

  it("keeps a genuine zero when every machine reports one", () => {
    expect(machineFloorCycles([{ cycleCount: 0 }, { cycleCount: 0 }])).toEqual({
      kind: "complete",
      value: "0",
      coverage: "ครบทั้ง 2 เครื่อง"
    });
  });

  it("says nothing is countable rather than reporting a zero floor", () => {
    expect(machineFloorCycles([{ cycleCount: null }, { cycleCount: null }])).toEqual({
      kind: "unavailable",
      value: "ไม่พร้อมใช้งาน",
      coverage: "ไม่ทราบจำนวนเครื่องที่นับได้"
    });
  });
});
