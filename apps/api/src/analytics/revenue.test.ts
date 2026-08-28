import { describe, expect, it } from "vitest";
import { buildTestApp, fakeClickhouse } from "./routes.test";
import type { FakeRow } from "./routes.test";

// Every row is all-synthetic: synthCount === totalCount, so window totals tag "synthetic".
const syntheticRows: FakeRow[] = [
  { date: "2026-08-01", branchId: "b1", branchName: "SYNTH-A", revenueSatang: "184000", cycles: "31", synthCount: "31", totalCount: "31", avgDurationMin: "38.2" },
  { date: "2026-08-02", branchId: "b1", branchName: "SYNTH-A", revenueSatang: "126500", cycles: "24", synthCount: "24", totalCount: "24", avgDurationMin: "35.0" }
];

// First row synthetic (31/31), second real (0/24): window totals 55 total / 31 synthetic → "mixed".
const mixedRows: FakeRow[] = [
  syntheticRows[0],
  { ...syntheticRows[1], synthCount: "0" }
];

const ownerApp = (rows: FakeRow[]) =>
  buildTestApp(
    { source: "demo", user: { id: "u1", name: "T", email: "t@e.com" }, grants: [{ id: "g", role: "owner", branchId: null }] },
    { clickhouse: fakeClickhouse([{ match: /fact_machine_usage/, rows }]) }
  );

// The scoping predicate must survive in the fixed SQL template itself — params alone
// don't prove filtering, so the query-text regex pins the bind usage in place.
const SCOPED_DAILY_QUERY = /fact_machine_usage[\s\S]*toString\(u\.branch_id\) = \{branchId:String\}/;

describe("revenue + cycles endpoints", () => {
  it("returns satang integers with synthetic meta for owner", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_machine_usage/, rows: syntheticRows }]);
    const app = buildTestApp(
      { source: "demo", user: { id: "u1", name: "T", email: "t@e.com" }, grants: [{ id: "g", role: "owner", branchId: null }] },
      { clickhouse }
    );

    const response = await app.request("/api/v1/analytics/revenue/daily?from=2026-08-01&to=2026-08-31");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data[0]).toEqual({ date: "2026-08-01", branchId: "b1", branchName: "SYNTH-A", revenueSatang: 184000, cycles: 31 });
    expect(body.meta.dataSource).toBe("synthetic");
    expect(body.meta.range).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    // Owner without a requested branch is tenant-wide: empty-string sentinel reaches the executor.
    expect(clickhouse).toHaveBeenCalledWith(
      expect.stringMatching(SCOPED_DAILY_QUERY),
      expect.objectContaining({ branchId: "", from: "2026-08-01", to: "2026-08-31" })
    );
  });

  it("tags mixed when synthetic and real cycles share the window", async () => {
    const app = ownerApp(mixedRows);

    const response = await app.request("/api/v1/analytics/revenue/daily");

    expect(response.status).toBe(200);
    const body = await response.json();
    // 55 total cycles across rows, 31 of them synthetic → neither pure tag applies.
    expect(body.meta.dataSource).toBe("mixed");
  });

  it("denies revenue to technicians with REVENUE_FORBIDDEN and never queries", async () => {
    const clickhouse = fakeClickhouse([{ match: /./, rows: [] }]);
    const app = buildTestApp({ source: "demo", user: { id: "u1", name: "T", email: "t@e.com" }, grants: [{ id: "g", role: "technician", branchId: "b1" }] }, { clickhouse });

    const response = await app.request("/api/v1/analytics/revenue/daily");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "REVENUE_FORBIDDEN", message: "Revenue analytics requires an owner or manager role" } });
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("cycles endpoint is available to technicians within their branch", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_machine_usage/, rows: syntheticRows.map((row) => ({ ...row, synthCount: "0" })) }]);
    const app = buildTestApp({ source: "demo", user: { id: "u1", name: "T", email: "t@e.com" }, grants: [{ id: "g", role: "technician", branchId: "b1" }] }, { clickhouse });

    const response = await app.request("/api/v1/analytics/cycles/daily?branchId=b1");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meta.dataSource).toBe("real");
    expect(body.meta.branchId).toBe("b1");
    expect(body.data[0]).toEqual({ date: "2026-08-01", branchId: "b1", branchName: "SYNTH-A", cycles: 31, avgDurationMin: 38.2 });
    expect(body.data[0].avgDurationMin).toBeCloseTo(38.2, 1);
    // Scope enforcement reaches the warehouse both as bound params and as the SQL predicate.
    expect(clickhouse).toHaveBeenCalledWith(
      expect.stringMatching(SCOPED_DAILY_QUERY),
      expect.objectContaining({ branchId: "b1" })
    );
  });

  it("rejects technicians requesting a branch outside their grant before querying", async () => {
    const clickhouse = fakeClickhouse([{ match: /./, rows: [] }]);
    const app = buildTestApp({ source: "demo", user: { id: "u1", name: "T", email: "t@e.com" }, grants: [{ id: "g", role: "technician", branchId: "b1" }] }, { clickhouse });

    const response = await app.request("/api/v1/analytics/cycles/daily?branchId=b2");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "BRANCH_FORBIDDEN", message: "You cannot view this branch" } });
    expect(clickhouse).not.toHaveBeenCalled();
  });
});
