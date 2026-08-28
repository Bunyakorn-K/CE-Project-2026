import { describe, expect, it } from "vitest";
import type { Principal } from "../access-store";
import { buildTestApp, fakeClickhouse } from "./routes.test";
import type { FakeRow } from "./routes.test";

const principalFor = (role: "owner" | "technician", branchId: string | null): Principal => ({
  source: "demo",
  user: { id: "u1", name: "T", email: "t@e.com" },
  grants: [{ id: "g", role, branchId }]
});

// Window counts repeat per row: 2/2 on each of two rows sums to 4/4 → "synthetic".
const curveRows: FakeRow[] = [
  { occurredAt: "2026-08-01 09:05:00", machineId: "m1", machineCode: "W-1", temperatureF: "140.5", temperatureC: "60.3", phase: "wash", synthCount: "2", totalCount: "2" },
  { occurredAt: "2026-08-01 09:20:00", machineId: "m1", machineCode: "W-1", temperatureF: null, temperatureC: null, phase: "spin", synthCount: "2", totalCount: "2" }
];

// Second sample real (0/2): summed totals 4 total / 2 synthetic → "mixed".
const mixedRows: FakeRow[] = [
  curveRows[0],
  { ...curveRows[1], synthCount: "0" }
] as FakeRow[];

// The FULL branch and machine disjunctions are pinned so a tenant-wide or
// unfiltered request cannot silently drop either predicate from the template.
const SCOPED_CURVE_QUERY = /\{branchId:String\} = '' OR toString\(s\.branch_id\) = \{branchId:String\}[\s\S]*\{machineId:String\} = '' OR s\.machine_id = \{machineId:String\}/;

describe("temperature curve endpoint", () => {
  it("returns samples with numeric temps, null passthrough, and synthetic meta for owners", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_temperature_sample/, rows: curveRows }]);
    const app = buildTestApp(principalFor("owner", null), { clickhouse });

    const response = await app.request("/api/v1/analytics/temperature/curve?from=2026-08-01&to=2026-08-31");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([
      { occurredAt: "2026-08-01 09:05:00", machineId: "m1", machineCode: "W-1", temperatureF: 140.5, temperatureC: 60.3, phase: "wash" },
      { occurredAt: "2026-08-01 09:20:00", machineId: "m1", machineCode: "W-1", temperatureF: null, temperatureC: null, phase: "spin" }
    ]);
    expect(body.meta.dataSource).toBe("synthetic");
    expect(body.meta.range).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    // Owner without filters is tenant-wide and unfiltered by machine: empty-string sentinels.
    expect(clickhouse).toHaveBeenCalledWith(
      expect.stringMatching(SCOPED_CURVE_QUERY),
      expect.objectContaining({ branchId: "", machineId: "", from: "2026-08-01", to: "2026-08-31" })
    );
  });

  it("tags mixed when synthetic and real samples share the window", async () => {
    const app = buildTestApp(principalFor("owner", null), {
      clickhouse: fakeClickhouse([{ match: /fact_temperature_sample/, rows: mixedRows }])
    });

    const response = await app.request("/api/v1/analytics/temperature/curve");

    expect(response.status).toBe(200);
    const body = await response.json();
    // 4 total samples in the window, 2 synthetic → neither pure tag applies.
    expect(body.meta.dataSource).toBe("mixed");
  });

  it("forwards the optional machineId filter as a bound param", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_temperature_sample/, rows: [] }]);
    const app = buildTestApp(principalFor("owner", null), { clickhouse });

    const response = await app.request("/api/v1/analytics/temperature/curve?from=2026-08-01&to=2026-08-02&machineId=m9");

    expect(response.status).toBe(200);
    expect(clickhouse).toHaveBeenCalledWith(
      // LIMIT stays inside the fixed template; the machine filter rides the bind, not the text.
      expect.stringMatching(/LIMIT 5000\s*$/),
      expect.objectContaining({ machineId: "m9" })
    );
    const body = await response.json();
    expect(body.data).toEqual([]);
  });

  it("serves technicians within their own branch scope", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_temperature_sample/, rows: curveRows.map((row) => ({ ...row, synthCount: "0" })) }]);
    const app = buildTestApp(principalFor("technician", "b1"), { clickhouse });

    const response = await app.request("/api/v1/analytics/temperature/curve?branchId=b1&machineId=m1");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meta.branchId).toBe("b1");
    expect(body.meta.dataSource).toBe("real");
    expect(clickhouse).toHaveBeenCalledWith(
      expect.stringMatching(SCOPED_CURVE_QUERY),
      expect.objectContaining({ branchId: "b1", machineId: "m1" })
    );
  });

  it("rejects cross-branch requests before querying", async () => {
    const clickhouse = fakeClickhouse([{ match: /./, rows: [] }]);
    const app = buildTestApp(principalFor("technician", "b1"), { clickhouse });

    const response = await app.request("/api/v1/analytics/temperature/curve?branchId=b2");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "BRANCH_FORBIDDEN", message: "You cannot view this branch" } });
    expect(clickhouse).not.toHaveBeenCalled();
  });
});
