import { describe, expect, it } from "vitest";
import { redactDashboardDataRevenue, redactDashboardRevenue } from "./reporting";

describe("reporting projection", () => {
  it("does not expose revenue aggregates to a technician", () => {
    const dashboard = {
      contractVersion: "2026-07-17",
      source: "postgres" as const,
      fetchedAt: "2026-07-17T00:00:00.000Z",
      range: { from: "2026-07-17T00:00:00.000Z", to: "2026-07-18T00:00:00.000Z" },
      branches: [
        {
          branch: { id: "branch-01", code: "01", name: "Branch 01", timezone: "Asia/Bangkok", status: "active" },
          kpi: { revenueSatang: 184000, cycles: 5, machineCount: 5, totalCycleMinutes: 300, utilization: 0.2 }
        }
      ],
      totals: { revenueSatang: 184000, cycles: 5, machineCount: 5 }
    };

    const projected = redactDashboardRevenue(dashboard, false);

    expect(projected.totals.revenueSatang).toBeNull();
    expect(projected.branches[0]?.kpi.revenueSatang).toBeNull();
  });
});

describe("ClickHouse dashboard revenue redaction", () => {
  const withRevenue = (): Parameters<typeof redactDashboardDataRevenue>[0] => ({
    from: "2026-09-24",
    to: "2026-09-25",
    source: "clickhouse",
    usageRowsInRange: 150,
    cycleAttribution: { countedRows: 120, attributedRows: 120, unattributedRows: 0 },
    totals: { revenueSatang: 60000, cycles: 120, machines: 19, running: 3 },
    branches: [
      {
        branchId: "branch-01",
        branchName: "Branch A",
        revenueSatang: 60000,
        cycles: 120,
        machines: 19,
        running: 3
      }
    ],
    trend: [
      { date: "2026-09-24", revenueSatang: 25000, cycles: 50, usageRows: 70 },
      { date: "2026-09-25", revenueSatang: 35000, cycles: 70, usageRows: 80 }
    ]
  });

  it("withholds the daily revenue series as well as the totals and the branches", () => {
    const projected = redactDashboardDataRevenue(withRevenue(), false);

    expect(projected.totals.revenueSatang).toBeNull();
    expect(projected.branches[0]?.revenueSatang).toBeNull();
    // A chart drawn beside a redacted KPI. Leaving the series in would hand a
    // technician the whole revenue trend while the number above it reads
    // "ไม่พร้อมใช้งาน" — the redaction undone by its own visualisation.
    expect(projected.trend!.map((point) => point.revenueSatang)).toEqual([null, null]);
  });

  // Zero would be a different and false claim: "this branch took no money on
  // this day" is a statement about the business, where `null` is a statement
  // about the viewer. Only the second is true here.
  it("withholds revenue as null, never as a zero that reads as a day with no takings", () => {
    const projected = redactDashboardDataRevenue(withRevenue(), false);

    expect(projected.trend!.every((point) => point.revenueSatang === null)).toBe(true);
  });

  it("keeps the cycle counts, which carry no revenue", () => {
    const projected = redactDashboardDataRevenue(withRevenue(), false);

    expect(projected.trend!.map((point) => point.cycles)).toEqual([50, 70]);
    expect(projected.trend!.map((point) => point.date)).toEqual(["2026-09-24", "2026-09-25"]);
  });

  it("leaves an owner grant untouched, revenue series included", () => {
    const dashboard = withRevenue();

    expect(redactDashboardDataRevenue(dashboard, true)).toBe(dashboard);
    expect(dashboard.trend!.map((point) => point.revenueSatang)).toEqual([25000, 35000]);
  });

  // A source that cannot report a trend must stay unable to, or the redaction
  // would "helpfully" turn `null` into an empty chart that reads as no trading.
  it("leaves a source that cannot report a trend reporting no trend", () => {
    const dashboard = { ...withRevenue(), trend: null };

    expect(redactDashboardDataRevenue(dashboard, false).trend).toBeNull();
  });
});
