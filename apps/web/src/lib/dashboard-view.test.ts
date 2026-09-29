import { describe, expect, it } from "vitest";
import {
  branchStatCells,
  cycleAttributionView,
  dashboardKpis,
  emptyStateMessage,
  usagePresence,
  utilizationView,
  type DashboardTotals,
  type UsagePresence
} from "./dashboard-view";

const TOTALS: DashboardTotals = { revenueSatang: 5374863, cycles: 420, machines: 6, running: 2 };
const EMPTY_TOTALS: DashboardTotals = { revenueSatang: 0, cycles: 0, machines: 6, running: 0 };

function format(value: number): string {
  return value.toLocaleString("th-TH");
}

function baht(satang: number): string {
  return `฿${(satang / 100).toLocaleString("th-TH", { maximumFractionDigits: 0 })}`;
}

function kpis(overrides: { totals?: DashboardTotals; presence: UsagePresence; range?: string }) {
  return dashboardKpis({
    totals: overrides.totals ?? TOTALS,
    branchCount: 2,
    firstBranchName: "สาขาเชียงใหม่",
    range: overrides.range ?? "1 ก.ย. 2026 — 25 ส.ค. 2026",
    presence: overrides.presence,
    formatNumber: format,
    formatBaht: baht
  });
}

describe("usagePresence", () => {
  it("reads a zero usage-row count as an empty window", () => {
    expect(usagePresence(0)).toBe("empty");
  });

  it("reads any positive usage-row count as a populated window", () => {
    expect(usagePresence(1)).toBe("present");
    expect(usagePresence(1755)).toBe("present");
  });

  it("keeps presence unknown when the source cannot count usage rows", () => {
    expect(usagePresence(null)).toBe("unknown");
    expect(usagePresence(undefined)).toBe("unknown");
  });

  it("does not read a negative or non-finite count as an empty window", () => {
    expect(usagePresence(-1)).toBe("unknown");
    expect(usagePresence(Number.NaN)).toBe("unknown");
  });
});

describe("emptyStateMessage", () => {
  it("says nothing when the window has usage", () => {
    expect(emptyStateMessage("present")).toBeNull();
  });

  it("says nothing when presence is unknown, so an uncounted window is not called empty", () => {
    expect(emptyStateMessage("unknown")).toBeNull();
  });

  it("matches the wording /analytics already uses for the same window", () => {
    expect(emptyStateMessage("empty")).toBe("ไม่มีข้อมูลการใช้งานในช่วงเวลานี้");
  });
});

describe("dashboardKpis", () => {
  it("renders the real numbers for a populated window", () => {
    const rendered = kpis({ presence: "present" });

    expect(rendered.revenue.value).toBe("฿53,749");
    expect(rendered.cycles.value).toBe("420");
    expect(rendered.cycles.detail).toBe("นับจากแถว usage · ข้อมูล 1 ก.ย. 2026 — 25 ส.ค. 2026");
    expect(rendered.inventory.value).toBe("6");
    expect(rendered.inventory.detail).toBe("2 รายการสถานะกำลังใช้งาน");
    expect(rendered.branches.value).toBe("2");
    expect(rendered.branches.detail).toBe("สาขาเชียงใหม่");
  });

  it("never claims usage-derived zeros for an empty window", () => {
    const rendered = kpis({ totals: EMPTY_TOTALS, presence: "empty", range: "22 ก.ย. 2026 — 28 ก.ย. 2026" });

    expect(rendered.revenue.value).toBe("ไม่มีข้อมูล");
    expect(rendered.cycles.value).toBe("ไม่มีข้อมูล");
    expect(rendered.revenue.textValue).toBe(true);
    expect(rendered.cycles.textValue).toBe(true);
    // `running` is usage-derived, so 0 in an empty window is unknown, not zero.
    expect(rendered.inventory.detail).toBe("ไม่มีหลักฐานสถานะกำลังใช้งานในช่วงเวลานี้");
  });

  it("keeps the machine count visible in an empty window because it is inventory", () => {
    const rendered = kpis({ totals: EMPTY_TOTALS, presence: "empty", range: "22 ก.ย. 2026 — 28 ก.ย. 2026" });

    expect(rendered.inventory.value).toBe("6");
    expect(rendered.branches.value).toBe("2");
  });

  // A window can hold sessions that never reached paid/finished, so cycles is
  // legitimately 0 while the window is not empty. Driving the empty state off
  // cycles === 0 would have hidden real data.
  it("shows a genuine zero for cycles in a window that has usage", () => {
    const rendered = kpis({ totals: { ...EMPTY_TOTALS, running: 1 }, presence: "present", range: "1 ก.ค. 2026 — 2 ก.ค. 2026" });

    expect(rendered.cycles.value).toBe("0");
    expect(rendered.revenue.value).toBe("฿0");
    expect(rendered.inventory.detail).toBe("1 รายการสถานะกำลังใช้งาน");
  });

  it("keeps technician revenue redaction distinct from an empty window", () => {
    const rendered = kpis({ totals: { ...TOTALS, revenueSatang: null }, presence: "present" });

    expect(rendered.revenue.value).toBe("ไม่พร้อมใช้งาน");
    expect(rendered.revenue.detail).toBe("ไม่มีสิทธิ์ดูรายได้");
    expect(rendered.cycles.value).toBe("420");
  });

  it("never labels the machine count as machines that have data", () => {
    const rendered = Object.values(kpis({ presence: "present" })).flatMap((cell) => [cell.label, cell.value, cell.detail]);

    expect(rendered.some((text) => text.includes("เครื่องที่มีข้อมูล"))).toBe(false);
  });

  // The KPI is a row count, not a session count. Naming the basis on the card
  // itself is what stops a reader from taking 3,905 for a count of fully
  // identified wash sessions.
  it("names the definition behind the cycle number on the card itself", () => {
    const rendered = kpis({ presence: "present" });

    expect(rendered.cycles.detail).toBe("นับจากแถว usage · ข้อมูล 1 ก.ย. 2026 — 25 ส.ค. 2026");
  });
});

describe("cycleAttributionView", () => {
  // The real warehouse shape: 2,591 of 3,905 counted rows carry no
  // machine_session_id. Presenting the total without this is presenting an
  // incomplete count as a complete one.
  it("states the measured gap when most counted rows carry no session id", () => {
    const view = cycleAttributionView({ countedRows: 3905, attributedRows: 1314, unattributedRows: 2591 }, format);

    expect(view.kind).toBe("partial");
    if (view.kind !== "partial") return;
    expect(view.message).toContain("2,591");
    expect(view.message).toContain("3,905");
    expect(view.message).toContain("66%");
    expect(view.percentage).toBe(66);
  });

  it("never lets the message read as a complete count while a gap exists", () => {
    const view = cycleAttributionView({ countedRows: 3905, attributedRows: 1314, unattributedRows: 2591 }, format);

    if (view.kind !== "partial") throw new Error("expected a partial gap");
    expect(view.message).toContain("ไม่ครบถ้วน");
    expect(view.message).not.toContain("ครบถ้วนทั้งหมด");
  });

  it("says the basis when every counted row carries a session id", () => {
    const view = cycleAttributionView({ countedRows: 40, attributedRows: 40, unattributedRows: 0 }, format);

    expect(view.kind).toBe("complete");
    if (view.kind !== "complete") return;
    expect(view.message).toContain("ทุกแถว");
  });

  // The demo/IRIS projection carries no machine_session_id. Reporting zero
  // unattributed rows there would assert a measurement that source cannot make.
  it("keeps the gap unknown when the source cannot measure attribution", () => {
    expect(cycleAttributionView(null, format).kind).toBe("unknown");
    expect(cycleAttributionView(undefined, format).kind).toBe("unknown");
  });

  it("has nothing to attribute in a window with no counted rows", () => {
    const view = cycleAttributionView({ countedRows: 0, attributedRows: 0, unattributedRows: 0 }, format);

    // Neither "complete" (a vacuous claim over zero rows) nor "unknown" (the
    // warehouse did measure it — it measured nothing). The empty-window message
    // already describes this window.
    expect(view.kind).toBe("none");
  });

  it("refuses to divide by a window with no counted rows", () => {
    const view = cycleAttributionView({ countedRows: 0, attributedRows: 5, unattributedRows: -5 }, format);

    expect(view.kind).toBe("unknown");
  });
});

describe("branchStatCells", () => {
  const branch = { branchId: "branch-01", branchName: "สาขาเชียงใหม่", revenueSatang: 5374863, cycles: 420, machines: 4, running: 2 };

  it("labels the machine count as inventory, not as machines with data", () => {
    const cells = branchStatCells(branch, "present", format, baht);

    expect(cells.machines.label).toBe("เครื่องที่เปิดใช้งาน");
    expect(cells.machines.value).toBe("4");
    expect(cells.revenue.value).toBe("฿53,749");
    expect(cells.cycles.value).toBe("420");
    expect(cells.running.value).toBe("2");
    expect(cells.statusPill).toBe("2/4 รายการสถานะ");
  });

  it("marks usage-derived cells unavailable for an empty window but keeps inventory", () => {
    const cells = branchStatCells({ ...branch, revenueSatang: 0, cycles: 0, running: 0 }, "empty", format, baht);

    expect(cells.revenue.value).toBe("ไม่มีข้อมูล");
    expect(cells.cycles.value).toBe("ไม่มีข้อมูล");
    expect(cells.running.value).toBe("ไม่มีข้อมูล");
    expect(cells.machines.value).toBe("4");
    expect(cells.statusPill).toBe("ไม่มีหลักฐานสถานะในช่วงเวลานี้");
  });
});

describe("utilizationView", () => {
  it("resolves to the ratio when the window has usage evidence", () => {
    expect(utilizationView({ branchName: "สาขาเชียงใหม่", machines: 4, running: 2 }, "present")).toEqual({
      kind: "ratio",
      percentage: 50,
      ariaLabel: "สาขาเชียงใหม่: รายการสถานะกำลังใช้งาน 2 จาก 4 เครื่องที่เปิดใช้งาน",
      ariaValueText: "50% ของเครื่องที่เปิดใช้งาน; ค่านี้มาจากรายการ usage ไม่ใช่สถานะทันที"
    });
  });

  // The branch card already had this honest branch; nothing could reach it.
  it("falls back to the honest message when the window has no usage evidence", () => {
    expect(utilizationView({ branchName: "สาขาเชียงใหม่", machines: 4, running: 0 }, "empty")).toEqual({
      kind: "unavailable",
      message: "ไม่มีข้อมูลการใช้งานในช่วงเวลานี้"
    });
  });

  it("falls back when presence cannot be established either", () => {
    expect(utilizationView({ branchName: "สาขาเชียงใหม่", machines: 4, running: 0 }, "unknown")).toEqual({
      kind: "unavailable",
      message: "ไม่มีข้อมูลการใช้งานในช่วงเวลานี้"
    });
  });

  it("still refuses to divide by an empty inventory", () => {
    expect(utilizationView({ branchName: "สาขาเชียงใหม่", machines: 0, running: 0 }, "present").kind).toBe("unavailable");
  });

  it("never tells a screen reader the denominator is machines that have data", () => {
    const view = utilizationView({ branchName: "สาขาเชียงใหม่", machines: 4, running: 2 }, "present");

    expect(view.kind).toBe("ratio");
    if (view.kind !== "ratio") return;
    expect(`${view.ariaLabel}${view.ariaValueText}`).not.toContain("เครื่องที่มีข้อมูล");
  });
});
