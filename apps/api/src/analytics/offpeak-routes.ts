import { Hono } from "hono";
import { ClickHouseUnavailableError } from "./clickhouse";
import { analyticsEnvelope } from "./envelope";
import { rankOffPeakBuckets } from "./offpeak";
import { registerPath } from "./openapi";
import { dataSourceEnvelope, queryOffPeakWindows } from "./queries";
import { analyticsError, gateAndScope, type AnalyticsAppEnv, type AnalyticsDeps } from "./routes";

/**
 * R09 off-peak windows over HTTP.
 *
 * This is the same ranking the `get_off_peak_windows` MCP tool returns, exposed
 * on the web so the recommendation is reachable from the browser and not only
 * from the LINE bot or LibreChat. The tool remains the assistant's surface; this
 * is the human-facing one.
 *
 * Ranked buckets are descriptive, not predictive — the response carries the
 * method and the rules so the browser can label it as such rather than
 * presenting "these are the quiet times" as a promise.
 */
export function registerOffPeakRoutes(app: Hono<AnalyticsAppEnv>, deps: AnalyticsDeps): void {
  registerPath({
    path: "/api/v1/analytics/off-peak",
    method: "get",
    summary: "Off-peak (hour, weekday) buckets ranked by lowest paid-cycle usage (R09 descriptive baseline)"
  });

  app.get("/api/v1/analytics/off-peak", async (c) => {
    const gate = gateAndScope(c);
    if (!gate.ok) return gate.response;

    // Validated rather than defaulted: a typo in the query string should not
    // silently rank a different population than the one asked for.
    const rawPercentile = c.req.query("percentile");
    const percentile = rawPercentile === undefined ? 25 : Number(rawPercentile);
    if (!Number.isInteger(percentile) || percentile < 1 || percentile > 99) {
      return analyticsError(c, 400, "INVALID_INPUT", "percentile must be an integer between 1 and 99");
    }
    const rawMinCycles = c.req.query("minCycles");
    const minCycles = rawMinCycles === undefined ? 10 : Number(rawMinCycles);
    if (!Number.isInteger(minCycles) || minCycles < 1) {
      return analyticsError(c, 400, "INVALID_INPUT", "minCycles must be an integer of at least 1");
    }

    try {
      const result = await queryOffPeakWindows(deps.clickhouse, gate.params);
      const ranked = rankOffPeakBuckets(result.rows, { minCycles, percentile });
      return c.json(
        analyticsEnvelope(
          {
            ...dataSourceEnvelope(gate.meta, result),
            method: ranked.meta.method,
            rules: ranked.meta.rules,
            caveats: [
              "buckets are Asia/Bangkok local hours (UTC+7, no DST)",
              "descriptive baseline from observed paid-cycle counts, not a forecast",
              "a rank is a quiet time in this window only; it is not a promise that the time stays quiet"
            ]
          },
          ranked.data
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
