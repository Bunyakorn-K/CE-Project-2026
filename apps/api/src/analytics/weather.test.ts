import { describe, expect, it, vi } from "vitest";
import type { ClickHouseExecutor } from "./clickhouse";
import { queryWeatherUsageCorrelation, WEATHER_CAVEAT, WEATHER_USAGE_CORRELATION_SQL } from "./weather";

const PARAMS = { from: "2026-08-01", to: "2026-08-31", branchId: "" };

describe("queryWeatherUsageCorrelation", () => {
  it("runs the parameterized SQL against the weather table with bound params", async () => {
    const clickhouse = vi.fn().mockResolvedValue([
      {
        date: "2026-08-27",
        branchName: "สาขาเชียงใหม่",
        cycles: "12",
        avgTempC: "33.67",
        avgHumidityPct: "49.14",
        totalRainMm: "0",
        missingTemp: "0",
        synthCount: "0",
        totalCount: "24"
      }
    ]) as unknown as ClickHouseExecutor;

    const result = await queryWeatherUsageCorrelation(clickhouse, PARAMS);

    expect(clickhouse).toHaveBeenCalledWith(WEATHER_USAGE_CORRELATION_SQL, PARAMS);
    expect(WEATHER_USAGE_CORRELATION_SQL).toContain("fact_weather_sample");
    expect(result.rows[0]).toEqual({
      date: "2026-08-27",
      branchName: "สาขาเชียงใหม่",
      cycles: 12,
      avgTempC: 33.67,
      avgHumidityPct: 49.14,
      totalRainMm: 0,
      missingTemp: 0
    });
    expect(result.totalRows).toBe(24);
  });

  it("preserves missing weather readings as null — never fabricates", async () => {
    const clickhouse = vi.fn().mockResolvedValue([
      {
        date: "2026-08-28",
        branchName: "สาขาเชียงใหม่",
        cycles: "0",
        avgTempC: null,
        avgHumidityPct: null,
        totalRainMm: null,
        missingTemp: "24",
        synthCount: "0",
        totalCount: "24"
      }
    ]) as unknown as ClickHouseExecutor;
    const result = await queryWeatherUsageCorrelation(clickhouse, PARAMS);
    expect(result.rows[0]).toMatchObject({ avgTempC: null, avgHumidityPct: null, totalRainMm: null, missingTemp: 24 });
  });

  it("carries the R12 correlation caveat", () => {
    expect(WEATHER_CAVEAT).toContain("Correlation only");
    expect(WEATHER_CAVEAT).toContain("not a forecast");
  });
});
