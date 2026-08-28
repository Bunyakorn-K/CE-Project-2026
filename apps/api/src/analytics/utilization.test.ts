import { describe, expect, it } from "vitest";
import type { Principal } from "../access-store";
import { buildTestApp, fakeClickhouse } from "./routes.test";
import type { FakeRow } from "./routes.test";

const principalFor = (role: "owner" | "technician", branchId: string | null): Principal => ({
  source: "demo",
  user: { id: "u1", name: "T", email: "t@e.com" },
  grants: [{ id: "g", role, branchId }]
});

// Every bucket is all-synthetic: synthCount === totalCount, so summed totals tag "synthetic".
const heatmapRows: FakeRow[] = [
  { hourBucket: "2026-08-01 09:00:00", machineId: "m1", machineCode: "W-1", totalDurationMin: "240", cycles: "6", synthCount: "6", totalCount: "6" },
  { hourBucket: "2026-08-01 10:00:00", machineId: "m2", machineCode: "D-2", totalDurationMin: "95", cycles: "3", synthCount: "3", totalCount: "3" }
];

// Second bucket real (0/3): summed totals 9 total / 6 synthetic → "mixed".
const mixedRows: FakeRow[] = [
  heatmapRows[0],
  { ...heatmapRows[1], synthCount: "0" }
] as FakeRow[];

// The scoping predicate must survive in the fixed SQL template itself — the FULL
// disjunction is pinned so a tenant-wide request cannot silently drop the branch filter.
const SCOPED_HEATMAP_QUERY = /\{branchId:String\} = '' OR toString\(u\.branch_id\) = \{branchId:String\}/;

describe("utilization heatmap endpoint", () => {
  it("returns hourly buckets with numeric aggregates and synthetic meta for owners", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_machine_usage/, rows: heatmapRows }]);
    const app = buildTestApp(principalFor("owner", null), { clickhouse });

    const response = await app.request("/api/v1/analytics/utilization/heatmap?from=2026-08-01&to=2026-08-31");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([
      { hourBucket: "2026-08-01 09:00:00", machineId: "m1", machineCode: "W-1", totalDurationMin: 240, cycles: 6 },
      { hourBucket: "2026-08-01 10:00:00", machineId: "m2", machineCode: "D-2", totalDurationMin: 95, cycles: 3 }
    ]);
    expect(body.meta.dataSource).toBe("synthetic");
    expect(body.meta.range).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    // Owner without a requested branch is tenant-wide: empty-string sentinel reaches the executor.
    expect(clickhouse).toHaveBeenCalledWith(
      expect.stringMatching(SCOPED_HEATMAP_QUERY),
      expect.objectContaining({ branchId: "", from: "2026-08-01", to: "2026-08-31" })
    );
  });

  it("tags mixed when synthetic and real cycles share the window", async () => {
    const app = buildTestApp(principalFor("owner", null), {
      clickhouse: fakeClickhouse([{ match: /fact_machine_usage/, rows: mixedRows }])
    });

    const response = await app.request("/api/v1/analytics/utilization/heatmap");

    expect(response.status).toBe(200);
    const body = await response.json();
    // 9 total cycles across buckets, 6 of them synthetic → neither pure tag applies.
    expect(body.meta.dataSource).toBe("mixed");
  });

  it("serves technicians within their own branch scope", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_machine_usage/, rows: heatmapRows.map((row) => ({ ...row, synthCount: "0" })) }]);
    const app = buildTestApp(principalFor("technician", "b1"), { clickhouse });

    const response = await app.request("/api/v1/analytics/utilization/heatmap?branchId=b1");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meta.branchId).toBe("b1");
    expect(body.meta.dataSource).toBe("real");
    // Scope enforcement reaches the warehouse both as bound params and as the SQL predicate.
    expect(clickhouse).toHaveBeenCalledWith(
      expect.stringMatching(SCOPED_HEATMAP_QUERY),
      expect.objectContaining({ branchId: "b1" })
    );
  });

  it("rejects cross-branch requests before querying", async () => {
    const clickhouse = fakeClickhouse([{ match: /./, rows: [] }]);
    const app = buildTestApp(principalFor("technician", "b1"), { clickhouse });

    const response = await app.request("/api/v1/analytics/utilization/heatmap?branchId=b2");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "BRANCH_FORBIDDEN", message: "You cannot view this branch" } });
    expect(clickhouse).not.toHaveBeenCalled();
  });
});
