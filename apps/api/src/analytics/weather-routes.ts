import { Hono } from "hono";
import { ClickHouseUnavailableError } from "./clickhouse";
import { analyticsEnvelope } from "./envelope";
import { registerPath } from "./openapi";
import { analyticsError, gateAndScope, type AnalyticsAppEnv, type AnalyticsDeps } from "./routes";
import { queryWeatherUsageCorrelation, WEATHER_CAVEAT, WEATHER_PROVENANCE_CAVEAT } from "./weather";

/**
 * F-12 / R12 weather-and-usage correlation over HTTP.
 *
 * The query and its `unverifiable` provenance tag already existed for the
 * `get_weather_usage_correlation` MCP tool; this exposes the same answer to the
 * browser. The provenance tag is the point — it is deliberately not `real`,
 * because `fact_weather_sample` has no marker column, and a web page is exactly
 * the kind of surface where "real" would be believed.
 */
export function registerWeatherRoutes(app: Hono<AnalyticsAppEnv>, deps: AnalyticsDeps): void {
  registerPath({
    path: "/api/v1/analytics/weather/usage",
    method: "get",
    summary: "Daily weather observations alongside cycle counts per branch (correlation only, R12)"
  });

  app.get("/api/v1/analytics/weather/usage", async (c) => {
    const gate = gateAndScope(c);
    if (!gate.ok) return gate.response;
    try {
      const result = await queryWeatherUsageCorrelation(deps.clickhouse, gate.params);
      return c.json(
        analyticsEnvelope(
          {
            ...gate.meta,
            // Not dataSourceEnvelope: that helper derives `real` from a
            // synthetic-row count, and this table has no such count to derive
            // from. weatherDataSource returns `unverifiable` for a non-empty
            // window on purpose.
            dataSource: result.dataSource,
            caveats: [WEATHER_PROVENANCE_CAVEAT, WEATHER_CAVEAT]
          },
          result.rows
        )
      );
    } catch (error) {
      if (error instanceof ClickHouseUnavailableError) {
        return analyticsError(c, 503, "ANALYTICS_SOURCE_UNAVAILABLE", "Analytics warehouse is unavailable");
      }
      throw error;
    }
  });
}
