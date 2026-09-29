import { Hono } from "hono";
import { ClickHouseUnavailableError } from "./clickhouse";
import { analyticsEnvelope } from "./envelope";
import { registerPath } from "./openapi";
import { dataSourceEnvelope, queryTemperatureCurve } from "./queries";
import { analyticsError, gateAndScope, type AnalyticsAppEnv, type AnalyticsDeps } from "./routes";

export function registerTemperatureRoutes(app: Hono<AnalyticsAppEnv>, deps: AnalyticsDeps): void {
  registerPath({ path: "/api/v1/analytics/temperature/curve", method: "get", summary: "Raw wash-phase temperature samples per machine (newest 5000 points in range; meta.truncation reports what the cap dropped)" });

  app.get("/api/v1/analytics/temperature/curve", async (c) => {
    const gate = gateAndScope(c);
    if (!gate.ok) return gate.response;
    const machineId = c.req.query("machineId") ?? "";
    try {
      const result = await queryTemperatureCurve(deps.clickhouse, { ...gate.params, machineId });
      // Truncation rides the envelope so the UI can say the range is partial
      // instead of describing 5,000 newest samples as the whole window.
      return c.json(
        analyticsEnvelope({ ...dataSourceEnvelope(gate.meta, result), truncation: result.truncation }, result.rows)
      );
    } catch (error) {
      if (error instanceof ClickHouseUnavailableError) {
        return analyticsError(c, 503, "ANALYTICS_SOURCE_UNAVAILABLE", "Analytics warehouse is unavailable");
      }
      throw error;
    }
  });
}
