import { describe, expect, it, vi } from "vitest";
import type { ClickHouseExecutor } from "./clickhouse";
import {
  queryWeatherUsageCorrelation,
  weatherDataSource,
  WEATHER_CAVEAT,
  WEATHER_PROVENANCE_CAVEAT,
  WEATHER_USAGE_CORRELATION_SQL
} from "./weather";

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
    // Correlation joins weather to usage on the UTC hour (timezone-safe) and
    // on the branch ids (weather is tagged per registered branch since 2026-09-10).
    expect(WEATHER_USAGE_CORRELATION_SQL).toContain("toStartOfHour(u.started_at) = toStartOfHour(w.timestamp)");
    expect(WEATHER_USAGE_CORRELATION_SQL).toContain("u.tenant_id = w.tenant_id AND u.branch_id = w.branch_id");
    expect(WEATHER_USAGE_CORRELATION_SQL).toContain("toString(w.branch_id) = {branchId:String}");
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

describe("weather provenance", () => {
  // fact_weather_sample has NO marker column: all nine columns in
  // apps/etl/src/schema.ts:113-124 are a location label or a reading. There is
  // no field that distinguishes a TMD observation from a generated one, so
  // `countIf(0) AS synthCount` made every response report `dataSource: "real"`
  // — asserting real measurements the warehouse cannot prove. Against the local
  // warehouse, which holds 2,880 rows that are all generated, the endpoint
  // answered `dataSource: "real", syntheticRows: 0`.
  it("never claims real measurements from a table with no provenance marker", () => {
    expect(WEATHER_USAGE_CORRELATION_SQL).not.toContain("countIf(0) AS synthCount");
  });

  it("reports the weather window as unverifiable rather than real", () => {
    expect(weatherDataSource(24)).toBe("unverifiable");
  });

  it("still reports an empty window as empty", () => {
    // "empty" is a fact about row count, not a provenance claim, so it holds
    // even without a marker column.
    expect(weatherDataSource(0)).toBe("empty");
  });

  it("carries a caveat naming the missing marker column", () => {
    expect(WEATHER_PROVENANCE_CAVEAT).toMatch(/synthetic|provenance|marker/i);
    expect(WEATHER_PROVENANCE_CAVEAT.length).toBeGreaterThan(0);
  });
});
