import { Hono } from "hono";
import { ClickHouseUnavailableError } from "./clickhouse";
import { analyticsEnvelope } from "./envelope";
import { registerPath } from "./openapi";
import { dataSourceEnvelope, queryTemperatureCurve } from "./queries";
import { analyticsError, gateAndScope, type AnalyticsAppEnv, type AnalyticsDeps } from "./routes";

export function registerTemperatureRoutes(app: Hono<AnalyticsAppEnv>, deps: AnalyticsDeps): void {
  registerPath({ path: "/api/v1/analytics/temperature/curve", method: "get", summary: "Raw wash-phase temperature samples per machine (capped at 5000 points)" });

  app.get("/api/v1/analytics/temperature/curve", async (c) => {
    const gate = gateAndScope(c);
    if (!gate.ok) return gate.response;
    const machineId = c.req.query("machineId") ?? "";
    try {
      const result = await queryTemperatureCurve(deps.clickhouse, { ...gate.params, machineId });
      return c.json(analyticsEnvelope(dataSourceEnvelope(gate.meta, result), result.rows));
    } catch (error) {
      if (error instanceof ClickHouseUnavailableError) {
        return analyticsError(c, 503, "ANALYTICS_SOURCE_UNAVAILABLE", "Analytics warehouse is unavailable");
      }
      throw error;
    }
  });
}
