import { describe, expect, it } from "vitest";
import { liveFreshnessRow, liveStateSource, liveStatusClaim, machineKindLabel } from "./live-machine-view";

/**
 * These cases are the production payload measured on 2026-10-01: 19 machines at
 * the real branch, of which 17 were `running`/`finished` with freshness
 * `unavailable`. Before the guard, all 17 rendered a green state pill directly
 * above a red `ไม่พร้อมใช้งาน` pill.
 */

describe("liveStatusClaim", () => {
  it("states a fresh machine's state plainly, in its own colour", () => {
    expect(liveStatusClaim({ state: "running", freshness: "fresh" })).toEqual({
      kind: "current",
      label: "กำลังใช้งาน",
      className: "status-pill--success"
    });
  });

  it("withholds the state of a machine with no recent usage evidence", () => {
    // The production case, verbatim: a `running` row whose freshness is
    // `unavailable`. Asserting `กำลังใช้งาน` here is the defect.
    expect(liveStatusClaim({ state: "running", freshness: "unavailable" })).toEqual({
      kind: "withheld",
      label: "ไม่ทราบสถานะปัจจุบัน",
      className: "status-pill--neutral",
      recordedLabel: "บันทึกล่าสุดว่า กำลังใช้งาน"
    });
  });

  it("never lets a withheld claim be mistaken for a live one", () => {
    // The invariant, stated directly so a future edit to the labels cannot
    // quietly re-assert a state: no withheld claim may carry a success colour
    // or the bare present-tense label.
    const withheld = liveStatusClaim({ state: "running", freshness: "unavailable" });
    expect(withheld.className).not.toContain("success");
    expect(withheld.label).not.toBe("กำลังใช้งาน");
    expect(withheld.kind).toBe("withheld");
  });

  it("withholds a finished cycle too, not only a running one", () => {
    // 10 of the 19 production machines were `finished`/`unavailable`.
    expect(liveStatusClaim({ state: "finished", freshness: "unavailable" })).toEqual({
      kind: "withheld",
      label: "ไม่ทราบสถานะปัจจุบัน",
      className: "status-pill--neutral",
      recordedLabel: "บันทึกล่าสุดว่า จบรอบแล้ว"
    });
  });

  it("has no recorded history to name when the machine reported no state", () => {
    expect(liveStatusClaim({ state: null, freshness: "unavailable" })).toEqual({
      kind: "withheld",
      label: "ไม่ทราบสถานะปัจจุบัน",
      className: "status-pill--neutral",
      recordedLabel: null
    });
  });

  it("keeps a stale machine's state but demotes it out of the success colour", () => {
    // Stale is not unhealthy — the row is real, just old. It must not be
    // withheld (that would discard true information) and must not be drawn in
    // green (that would read as a live machine).
    const claim = liveStatusClaim({ state: "running", freshness: "stale" });
    expect(claim.kind).toBe("last-recorded");
    expect(claim.className).not.toContain("success");
    expect(claim.label).toBe("สถานะล่าสุด: กำลังใช้งาน");
  });

  it("treats an unrecognised freshness as fresh, because only the enum may withhold a state", () => {
    // Withholding on a value this build does not recognise would hide a real
    // state every time the API adds a freshness. The twin page's own rule is the
    // opposite: show the source string rather than guess.
    expect(liveStatusClaim({ state: "running", freshness: "brand-new-value" })).toEqual({
      kind: "current",
      label: "กำลังใช้งาน",
      className: "status-pill--success"
    });
  });

  it("treats an absent freshness as fresh, not as unavailable", () => {
    // The dangerous direction is defaulting to withheld: that would claim the
    // product knows less than an older API build told it. It asserts nothing
    // about currency, which is what the missing field means.
    expect(liveStatusClaim({ state: "running", freshness: null }).kind).toBe("current");
  });
});

describe("liveFreshnessRow", () => {
  it("returns nothing when the payload carries no freshness", () => {
    // Absent must not become "ความสดไม่ทราบ" on every card of an older build;
    // rendering nothing asserts nothing.
    expect(liveFreshnessRow(null)).toBeNull();
    expect(liveFreshnessRow(undefined)).toBeNull();
  });

  it("maps a known freshness to its Thai pill", () => {
    expect(liveFreshnessRow("unavailable")?.label).toBe("ไม่พร้อมใช้งาน");
  });
});

describe("liveStateSource", () => {
  it("reports the unavailable state source the API sends on every machine", () => {
    // The measured production value, verbatim.
    expect(
      liveStateSource({ liveState: { available: false, reason: "Digital Twin state is derived from usage data; live telemetry is unavailable" } })
    ).toEqual({ available: false, reason: "Digital Twin state is derived from usage data; live telemetry is unavailable" });
  });

  it("reports an available state source without inventing a reason", () => {
    expect(liveStateSource({ liveState: { available: true } })).toEqual({ available: true, reason: null });
  });

  it("distinguishes absent coverage from an unavailable source", () => {
    // Three states that must never render the same: no claim, a source that
    // exists and is unavailable, and a source that works.
    expect(liveStateSource(undefined)).toEqual({ known: false });
    expect(liveStateSource({})).toEqual({ known: false });
    expect(liveStateSource({ liveState: { available: false } })).toEqual({
      available: false,
      reason: "ไม่ทราบเหตุผลที่ไม่มีข้อมูลสด"
    });
  });
});

describe("machineKindLabel", () => {
  it("names the two kinds the product has and shows an unknown one verbatim", () => {
    expect(machineKindLabel("washer")).toBe("เครื่องซักผ้า");
    expect(machineKindLabel("dryer")).toBe("เครื่องอบผ้า");
    // Unknown kinds are shown, not hidden — the machine is still on the floor.
    expect(machineKindLabel("ironing")).toBe("ironing");
    expect(machineKindLabel(null)).toBe("ไม่ระบุประเภท");
  });
});