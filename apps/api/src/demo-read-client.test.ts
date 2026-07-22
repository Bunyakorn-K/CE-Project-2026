import { describe, expect, it } from "vitest";
import { createDemoReadClient } from "./demo-read-client";

describe("demo read client", () => {
  it("returns labeled demo data without an IRIS network request", async () => {
    const client = createDemoReadClient(() => new Date("2026-07-19T09:00:00.000Z"));

    const branches = await client.getBranches();
    const dashboard = await client.getDashboard({ branchId: branches.branches[0]?.id });
    const live = await client.getLiveSnapshot(branches.branches[0]!.id);

    expect(branches.source).toBe("demo");
    expect(dashboard.totals.machineCount).toBeGreaterThan(0);
    expect(live.machines).toHaveLength(3);
  });
});
