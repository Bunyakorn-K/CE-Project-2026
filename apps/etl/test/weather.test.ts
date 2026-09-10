import { describe, expect, it, vi } from "vitest";
import {
  fetchTmdForecast,
  loadWeatherBranches,
  normalizeForecast,
  runWeatherCollector,
  type TmdForecastResponse,
  type WeatherBranch
} from "../src/weather";
import type { ClickHouseClient } from "../src/clickhouse";

const BRANCH: WeatherBranch = { tenant_id: "9069c13d-f590-402e-a200-08fe26bde21c", branch_id: "5e9611c1-6380-4d58-8ec7-ba4fb8fe4369", province: "เชียงใหม่" };

const SAMPLE_RESPONSE = {
  WeatherForecasts: [
    {
      location: { province: "เชียงใหม่", lat: 18.79, lon: 98.98 },
      forecasts: [
        { time: "2026-08-27T15:00:00+07:00", data: { tc: 33.67, rh: 49.14, rain: 0, cond: 3 } },
        { time: "2026-08-27T16:00:00+07:00", data: { tc: 30.85 } }
      ]
    }
  ]
};

describe("normalizeForecast", () => {
  it("converts TMD +07:00 timestamps to UTC warehouse timestamps, tagged with the branch", () => {
    const rows = normalizeForecast(SAMPLE_RESPONSE, BRANCH);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      // 15:00 +07:00 = 08:00 UTC
      timestamp: "2026-08-27 08:00:00.000",
      tenant_id: BRANCH.tenant_id,
      branch_id: BRANCH.branch_id,
      province: "เชียงใหม่",
      weather_temp_c: 33.67,
      weather_humidity_pct: 49.14,
      weather_rain_mm: 0,
      weather_cond: 3
    });
  });

  it("preserves missing readings as null — never fabricates", () => {
    const rows = normalizeForecast(SAMPLE_RESPONSE, BRANCH);
    expect(rows[1]).toMatchObject({
      weather_temp_c: 30.85,
      weather_humidity_pct: null,
      weather_rain_mm: null,
      weather_cond: null
    });
  });

  it("returns no rows when the response has no forecasts", () => {
    expect(normalizeForecast({ WeatherForecasts: [] }, BRANCH)).toEqual([]);
    expect(normalizeForecast({}, BRANCH)).toEqual([]);
  });

  it("falls back to the provided now() time (UTC) when a forecast point has no time", () => {
    const now = () => new Date("2026-08-27T15:00:00.000Z");
    const rows = normalizeForecast(
      { WeatherForecasts: [{ forecasts: [{ data: { tc: 1 } }] }] } as unknown as TmdForecastResponse,
      BRANCH,
      now
    );
    // now() is already UTC here, so the fallback string is the same instant.
    expect(rows[0].timestamp).toBe("2026-08-27 15:00:00.000");
  });
});

describe("timezone handling (UTC invariant)", () => {
  it("shifts a +07:00 TMD timestamp back to UTC", () => {
    const rows = normalizeForecast(
      {
        WeatherForecasts: [
          { location: { province: "เชียงใหม่" }, forecasts: [{ time: "2026-08-27T22:00:00+07:00", data: { tc: 1 } }] }
        ]
      },
      BRANCH
    );
    // 22:00 +07:00 == 15:00 UTC
    expect(rows[0].timestamp).toBe("2026-08-27 15:00:00.000");
  });

  it("produces a UTC literal (space separator, millis, no Z)", () => {
    const rows = normalizeForecast(SAMPLE_RESPONSE, BRANCH);
    expect(rows[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(rows[0].timestamp).not.toContain("T");
    expect(rows[0].timestamp).not.toContain("Z");
    expect(rows[0].timestamp).not.toContain("+");
  });
});

describe("loadWeatherBranches", () => {
  it("loads active branches that carry a province label", async () => {
    const query = vi.fn(async () => [
      { tenant_id: "9069c13d-f590-402e-a200-08fe26bde21c", branch_id: "5e9611c1-6380-4d58-8ec7-ba4fb8fe4369", province: "เชียงใหม่" }
    ]);
    const branches = await loadWeatherBranches({ query } as unknown as Pick<ClickHouseClient, "query">);
    expect(branches).toEqual([{ tenant_id: "9069c13d-f590-402e-a200-08fe26bde21c", branch_id: "5e9611c1-6380-4d58-8ec7-ba4fb8fe4369", province: "เชียงใหม่" }]);
    const args = vi.mocked(query).mock.calls.at(0) as unknown[] | undefined;
    const sql = String(args?.[0]);
    expect(sql).toContain("dim_branch");
    expect(sql).toContain("active = 1");
    expect(sql).toContain("province IS NOT NULL");
  });

  it("returns [] when no branch has a province (nothing fabricated)", async () => {
    const query = vi.fn(async (): Promise<Array<{ tenant_id: string; branch_id: string; province: string }>> => []);
    const branches = await loadWeatherBranches({ query } as unknown as Pick<ClickHouseClient, "query">);
    expect(branches).toEqual([]);
  });
});

describe("fetchTmdForecast", () => {
  it("sends the bearer key and province, and parses the response", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
    );
    const data = await fetchTmdForecast("test-key", "เชียงใหม่", fetchImpl as unknown as typeof fetch);
    expect(data.WeatherForecasts?.[0]?.forecasts).toHaveLength(2);

    const url = String(vi.mocked(fetchImpl).mock.calls[0][0]);
    expect(url).toContain("data.tmd.go.th");
    expect(url).toContain(encodeURIComponent("เชียงใหม่"));
    const headers = vi.mocked(fetchImpl).mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
  });

  it("throws with the status on error responses", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("nope", { status: 401 }));
    await expect(fetchTmdForecast("bad", "เชียงใหม่", fetchImpl as unknown as typeof fetch)).rejects.toThrow("401");
  });
});

describe("runWeatherCollector", () => {
  it("fetches every branch and inserts rows tagged with tenant/branch ids", async () => {
    const insert = vi.fn(async (_table: string, _rows: unknown[]) => undefined);
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
    );

    const result = await runWeatherCollector({
      apiKey: "test-key",
      branches: [BRANCH],
      warehouse: { insert } as unknown as Pick<ClickHouseClient, "insert">,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.fetched).toBe(1);
    expect(result.rows).toBe(2); // 1 branch × 2 forecast points
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toBe("fact_weather_sample");
    const insertedRows = insert.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(insertedRows[0]).toMatchObject({ tenant_id: BRANCH.tenant_id, branch_id: BRANCH.branch_id, province: "เชียงใหม่" });
  });

  it("skips insert when a branch returns no forecasts", async () => {
    const insert = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));

    const result = await runWeatherCollector({
      apiKey: "test-key",
      branches: [BRANCH],
      warehouse: { insert } as unknown as Pick<ClickHouseClient, "insert">,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.rows).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });
});