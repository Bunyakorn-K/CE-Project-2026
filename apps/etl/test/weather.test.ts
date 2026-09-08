import { describe, expect, it, vi } from "vitest";
import {
  fetchTmdForecast,
  normalizeForecast,
  parseProvinces,
  runWeatherCollector,
  type TmdForecastResponse
} from "../src/weather";
import type { ClickHouseClient } from "../src/clickhouse";

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
  it("converts TMD +07:00 timestamps to UTC warehouse timestamps", () => {
    const rows = normalizeForecast(SAMPLE_RESPONSE, "เชียงใหม่");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      // 15:00 +07:00 = 08:00 UTC
      timestamp: "2026-08-27 08:00:00.000",
      province: "เชียงใหม่",
      weather_temp_c: 33.67,
      weather_humidity_pct: 49.14,
      weather_rain_mm: 0,
      weather_cond: 3
    });
  });

  it("preserves missing readings as null — never fabricates", () => {
    const rows = normalizeForecast(SAMPLE_RESPONSE, "เชียงใหม่");
    expect(rows[1]).toMatchObject({
      weather_temp_c: 30.85,
      weather_humidity_pct: null,
      weather_rain_mm: null,
      weather_cond: null
    });
  });

  it("returns no rows when the response has no forecasts", () => {
    expect(normalizeForecast({ WeatherForecasts: [] }, "เชียงใหม่")).toEqual([]);
    expect(normalizeForecast({}, "เชียงใหม่")).toEqual([]);
  });

  it("falls back to the provided now() time (UTC) when a forecast point has no time", () => {
    const now = () => new Date("2026-08-27T15:00:00.000Z");
    const rows = normalizeForecast(
      { WeatherForecasts: [{ forecasts: [{ data: { tc: 1 } }] }] } as unknown as TmdForecastResponse,
      "เชียงใหม่",
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
      "เชียงใหม่"
    );
    // 22:00 +07:00 == 15:00 UTC
    expect(rows[0].timestamp).toBe("2026-08-27 15:00:00.000");
  });

  it("produces a UTC literal (space separator, millis, no Z)", () => {
    const rows = normalizeForecast(SAMPLE_RESPONSE, "เชียงใหม่");
    expect(rows[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(rows[0].timestamp).not.toContain("T");
    expect(rows[0].timestamp).not.toContain("Z");
    expect(rows[0].timestamp).not.toContain("+");
  });
});

describe("parseProvinces", () => {
  it("parses a comma list and trims", () => {
    expect(parseProvinces(" เชียงใหม่, ชลบุรี ")).toEqual(["เชียงใหม่", "ชลบุรี"]);
  });

  it("falls back to เชียงใหม่ when unset or empty", () => {
    expect(parseProvinces(undefined)).toEqual(["เชียงใหม่"]);
    expect(parseProvinces("  , ")).toEqual(["เชียงใหม่"]);
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
  it("fetches every province and inserts normalized rows", async () => {
    const insert = vi.fn(async (_table: string, _rows: unknown[]) => undefined);
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
    );

    const result = await runWeatherCollector({
      apiKey: "k",
      provinces: ["เชียงใหม่", "ชลบุรี"],
      warehouse: { insert } as unknown as Pick<ClickHouseClient, "insert">,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.fetched).toBe(2);
    expect(result.rows).toBe(4); // 2 provinces × 2 forecast points
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert.mock.calls[0][0]).toBe("fact_weather_sample");
  });

  it("skips insert when a province returns no forecasts", async () => {
    const insert = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));

    const result = await runWeatherCollector({
      apiKey: "k",
      provinces: ["เชียงใหม่"],
      warehouse: { insert } as unknown as Pick<ClickHouseClient, "insert">,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.rows).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });
});
