import { Hono } from "hono";
import { mayViewRevenue } from "../access-policy";
import { ClickHouseUnavailableError } from "./clickhouse";
import { analyticsEnvelope } from "./envelope";
import { registerPath } from "./openapi";
import { dataSourceEnvelope, queryDailyCycles, queryDailyRevenue } from "./queries";
import { analyticsError, gateAndScope, type AnalyticsAppEnv, type AnalyticsDeps } from "./routes";

export function registerRevenueRoutes(app: Hono<AnalyticsAppEnv>, deps: AnalyticsDeps): void {
  registerPath({ path: "/api/v1/analytics/revenue/daily", method: "get", summary: "Daily gross revenue and cycles per branch (satang)" });
  registerPath({ path: "/api/v1/analytics/cycles/daily", method: "get", summary: "Daily cycle counts and average duration per branch" });

  app.get("/api/v1/analytics/revenue/daily", async (c) => {
    const gate = gateAndScope(c);
    if (!gate.ok) return gate.response;
    const principal = c.get("principal");
    if (!principal || !mayViewRevenue(principal.grants)) {
      return analyticsError(c, 403, "REVENUE_FORBIDDEN", "Revenue analytics requires an owner or manager role");
    }
    try {
      const result = await queryDailyRevenue(deps.clickhouse, gate.params);
      return c.json(analyticsEnvelope(dataSourceEnvelope(gate.meta, result), result.rows));
    } catch (error) {
      if (error instanceof ClickHouseUnavailableError) {
        return analyticsError(c, 503, "ANALYTICS_SOURCE_UNAVAILABLE", "Analytics warehouse is unavailable");
      }
      throw error;
    }
  });

  app.get("/api/v1/analytics/cycles/daily", async (c) => {
    const gate = gateAndScope(c);
    if (!gate.ok) return gate.response;
    try {
      const result = await queryDailyCycles(deps.clickhouse, gate.params);
      return c.json(analyticsEnvelope(dataSourceEnvelope(gate.meta, result), result.rows));
    } catch (error) {
      if (error instanceof ClickHouseUnavailableError) {
        return analyticsError(c, 503, "ANALYTICS_SOURCE_UNAVAILABLE", "Analytics warehouse is unavailable");
      }
      throw error;
    }
  });
}
