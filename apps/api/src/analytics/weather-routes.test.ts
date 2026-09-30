import { describe, expect, it } from "vitest";
import { buildTestApp, fakeClickhouse, type FakeRow } from "./routes.test";

const OWNER = { source: "demo" as const, user: { id: "u1", name: "T", email: "t@e.com" }, grants: [{ id: "g1", role: "owner" as const, branchId: null }] };

const day = (date: string, temp: number | null, rain: number | null): FakeRow => ({
  date,
  branchName: "SYNTH-A",
  cycles: "20",
  avgTempC: temp === null ? null : String(temp),
  avgHumidityPct: "60",
  totalRainMm: rain === null ? null : String(rain),
  missingTemp: temp === null ? "24" : "0",
  totalCount: "24"
});

const URL = "/api/v1/analytics/weather/usage?from=2026-08-01&to=2026-08-31";
const WEATHER = /weather/i;

describe("GET /api/v1/analytics/weather/usage", () => {
  it("requires a session", async () => {
    const clickhouse = fakeClickhouse([]);
    const app = buildTestApp(null, { clickhouse });
    expect((await app.request(URL)).status).toBe(401);
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("rejects a non-calendar date before querying", async () => {
    const clickhouse = fakeClickhouse([]);
    const app = buildTestApp(OWNER, { clickhouse });
    expect((await app.request("/api/v1/analytics/weather/usage?from=nope&to=2026-08-31")).status).toBe(400);
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("reports a non-empty window as unverifiable, never as real", async () => {
    const clickhouse = fakeClickhouse([{ match: WEATHER, rows: [day("2026-08-01", 30, 0)] }]);
    const app = buildTestApp(OWNER, { clickhouse });
    const body = (await (await app.request(URL)).json()) as { meta: { dataSource: string; caveats: string[] } };

    // fact_weather_sample carries no provenance marker, so "real" would be a
    // claim the warehouse cannot support.
    expect(body.meta.dataSource).toBe("unverifiable");
    expect(body.meta.caveats.join(" ")).toContain("Provenance unverifiable");
  });

  it("carries the correlation-not-causation caveat on every answer", async () => {
    const clickhouse = fakeClickhouse([{ match: WEATHER, rows: [day("2026-08-01", 30, 0)] }]);
    const app = buildTestApp(OWNER, { clickhouse });
    const body = (await (await app.request(URL)).json()) as { meta: { caveats: string[] } };
    expect(body.meta.caveats.join(" ")).toContain("does not establish causation");
  });

  it("keeps a missing temperature as null rather than a zero reading", async () => {
    const clickhouse = fakeClickhouse([{ match: WEATHER, rows: [day("2026-08-01", null, null)] }]);
    const app = buildTestApp(OWNER, { clickhouse });
    const body = (await (await app.request(URL)).json()) as {
      data: Array<{ avgTempC: number | null; totalRainMm: number | null; missingTemp: number }>;
    };
    expect(body.data[0].avgTempC).toBeNull();
    expect(body.data[0].totalRainMm).toBeNull();
    expect(body.data[0].missingTemp).toBe(24);
  });

  it("reports an empty window as empty", async () => {
    const clickhouse = fakeClickhouse([{ match: WEATHER, rows: [] }]);
    const app = buildTestApp(OWNER, { clickhouse });
    const body = (await (await app.request(URL)).json()) as { meta: { dataSource: string }; data: unknown[] };
    expect(body.meta.dataSource).toBe("empty");
    expect(body.data).toEqual([]);
  });
});
