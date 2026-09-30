import { describe, expect, it } from "vitest";
import { buildTestApp, fakeClickhouse, type FakeRow } from "./routes.test";

const OWNER = { source: "demo" as const, user: { id: "u1", name: "T", email: "t@e.com" }, grants: [{ id: "g1", role: "owner" as const, branchId: null }] };
const TECH = { source: "demo" as const, user: { id: "u2", name: "T", email: "t@e.com" }, grants: [{ id: "g2", role: "technician" as const, branchId: "b1" }] };

const bucket = (dayOfWeek: number, hourOfDay: number, cycles: number): FakeRow => ({
  dayOfWeek: String(dayOfWeek),
  hourOfDay: String(hourOfDay),
  branchId: "b1",
  branchName: "SYNTH-A",
  cycles: String(cycles),
  totalDurationMin: String(cycles * 30)
});

const RANGE = "?from=2026-08-01&to=2026-08-31";
const URL = `/api/v1/analytics/off-peak${RANGE}`;

describe("GET /api/v1/analytics/off-peak", () => {
  it("requires a session", async () => {
    const clickhouse = fakeClickhouse([]);
    const app = buildTestApp(null, { clickhouse });
    const response = await app.request(URL);
    expect(response.status).toBe(401);
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("rejects a non-calendar date before querying", async () => {
    const clickhouse = fakeClickhouse([]);
    const app = buildTestApp(OWNER, { clickhouse });
    const response = await app.request("/api/v1/analytics/off-peak?from=2026-08-01&to=not-a-date");
    expect(response.status).toBe(400);
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("returns ranked buckets with the rules that produced them", async () => {
    const clickhouse = fakeClickhouse([{ match: /dayOfWeek|weekday/i, rows: [bucket(1, 3, 2), bucket(2, 14, 40)] }]);
    const app = buildTestApp(OWNER, { clickhouse });
    const response = await app.request(URL);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      meta: { method: string; rules: Record<string, unknown>; caveats: string[] };
      data: Array<{ rank: number; weekday: string; hourOfDay: number }>;
    };
    expect(body.meta.method).toBe("offpeak_percentile");
    expect(body.meta.rules).toMatchObject({ minCycles: 10, percentile: 25 });
    // Buckets below minCycles are dropped, so only the busy one survives and it
    // is rank 1 of the returned set.
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ rank: 1, hourOfDay: 14, weekday: "Tue" });
  });

  it("states that the buckets are local hours", async () => {
    const clickhouse = fakeClickhouse([{ match: /dayOfWeek|weekday/i, rows: [bucket(1, 3, 40)] }]);
    const app = buildTestApp(OWNER, { clickhouse });
    const body = (await (await app.request(URL)).json()) as { meta: { caveats: string[] } };
    expect(body.meta.caveats.join(" ")).toContain("UTC+7");
  });

  it("honours a caller-supplied minCycles and percentile", async () => {
    const clickhouse = fakeClickhouse([{ match: /dayOfWeek|weekday/i, rows: [bucket(1, 3, 5), bucket(2, 14, 40), bucket(3, 9, 30)] }]);
    const app = buildTestApp(OWNER, { clickhouse });
    const body = (await (await app.request(`${URL}&minCycles=1&percentile=50`)).json()) as {
      meta: { rules: Record<string, unknown> };
      data: unknown[];
    };
    expect(body.meta.rules).toMatchObject({ minCycles: 1, percentile: 50 });
    expect(body.data).toHaveLength(2);
  });

  it("refuses a percentile outside 1-99 instead of silently clamping", async () => {
    const clickhouse = fakeClickhouse([{ match: /dayOfWeek|weekday/i, rows: [] }]);
    const app = buildTestApp(OWNER, { clickhouse });
    expect((await app.request(`${URL}&percentile=150`)).status).toBe(400);
    expect((await app.request(`${URL}&percentile=0`)).status).toBe(400);
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("reports an empty window as empty rather than as no off-peak time", async () => {
    const clickhouse = fakeClickhouse([{ match: /dayOfWeek|weekday/i, rows: [] }]);
    const app = buildTestApp(OWNER, { clickhouse });
    const body = (await (await app.request(URL)).json()) as { meta: { dataSource: string }; data: unknown[] };
    expect(body.meta.dataSource).toBe("empty");
    expect(body.data).toEqual([]);
  });

  it("scopes to the caller's own branch", async () => {
    const clickhouse = fakeClickhouse([{ match: /dayOfWeek|weekday/i, rows: [] }]);
    const app = buildTestApp(TECH, { clickhouse });
    const response = await app.request(URL);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { meta: { branchId: string | null } };
    expect(body.meta.branchId).toBe("b1");
  });

  it("denies a branch the caller is not granted", async () => {
    const clickhouse = fakeClickhouse([{ match: /dayOfWeek|weekday/i, rows: [] }]);
    const app = buildTestApp(TECH, { clickhouse });
    const response = await app.request(`${URL}&branchId=b2`);
    expect(response.status).toBe(403);
    expect(clickhouse).not.toHaveBeenCalled();
  });
});
