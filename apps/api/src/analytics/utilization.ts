import { Hono } from "hono";
import { ClickHouseUnavailableError } from "./clickhouse";
import { analyticsEnvelope } from "./envelope";
import { registerPath } from "./openapi";
import { dataSourceEnvelope, queryUtilizationHeatmap } from "./queries";
import { analyticsError, gateAndScope, type AnalyticsAppEnv, type AnalyticsDeps } from "./routes";

export function registerUtilizationRoutes(app: Hono<AnalyticsAppEnv>, deps: AnalyticsDeps): void {
  registerPath({ path: "/api/v1/analytics/utilization/heatmap", method: "get", summary: "Hourly utilization heatmap: duration minutes and cycles per machine-hour bucket" });

  app.get("/api/v1/analytics/utilization/heatmap", async (c) => {
    const gate = gateAndScope(c);
    if (!gate.ok) return gate.response;
    try {
      const result = await queryUtilizationHeatmap(deps.clickhouse, gate.params);
      return c.json(analyticsEnvelope(dataSourceEnvelope(gate.meta, result), result.rows));
    } catch (error) {
      if (error instanceof ClickHouseUnavailableError) {
        return analyticsError(c, 503, "ANALYTICS_SOURCE_UNAVAILABLE", "Analytics warehouse is unavailable");
      }
      throw error;
    }
  });
}
