import { describe, expect, it } from "vitest";
import { redactDashboardRevenue } from "./reporting";

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
