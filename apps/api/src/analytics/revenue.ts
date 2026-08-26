import { Hono } from "hono";
import { mayViewRevenue } from "../access-policy";
import { ClickHouseUnavailableError } from "./clickhouse";
import { analyticsEnvelope, dataSourceFromCounts, type AnalyticsMeta } from "./envelope";
import { registerPath } from "./openapi";
import { analyticsError, gateAndScope, type AnalyticsAppEnv, type AnalyticsDeps } from "./routes";

// Fixed SQL template — all user input flows through {from:String}{to:String}{branchId:String}
// bind parameters; nothing is ever concatenated into the query text.
const DAILY_SQL = `
SELECT
  toDate(started_at) AS date,
  u.branch_id AS branchId,
  b.branch_name AS branchName,
  sumIf(amount_satang, status IN ('finished','paid')) AS revenueSatang,
  countIf(status IN ('finished','paid')) AS cycles,
  avgIf(duration_min, status IN ('finished','paid')) AS avgDurationMin,
  countIf(source_event_id LIKE 'synthetic:%') AS synthCount,
  count() AS totalCount
FROM fact_machine_usage AS u
INNER JOIN dim_branch AS b ON (u.tenant_id = b.tenant_id AND u.branch_id = b.branch_id)
WHERE started_at >= {from:String} AND started_at < plus(toDate({to:String}), 1)
  AND ({branchId:String} = '' OR u.branch_id = {branchId:String})
GROUP BY date, branchId, branchName
ORDER BY date, branchName`;

type DailyRow = {
  date: string;
  branchId: string;
  branchName: string;
  revenueSatang: string;
  cycles: string;
  avgDurationMin: string;
  synthCount: string;
  totalCount: string;
};

function dailyEnvelope(meta: AnalyticsMeta, rows: DailyRow[]) {
  const totalRows = rows.reduce((sum, row) => sum + Number(row.totalCount), 0);
  const syntheticRows = rows.reduce((sum, row) => sum + Number(row.synthCount), 0);
  return { ...meta, dataSource: dataSourceFromCounts(totalRows, syntheticRows) };
}

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
    let rows: DailyRow[];
    try {
      rows = await deps.clickhouse<DailyRow>(DAILY_SQL, gate.params);
    } catch (error) {
      if (error instanceof ClickHouseUnavailableError) {
        return analyticsError(c, 503, "ANALYTICS_SOURCE_UNAVAILABLE", "Analytics warehouse is unavailable");
      }
      throw error;
    }
    return c.json(
      analyticsEnvelope(
        dailyEnvelope(gate.meta, rows),
        rows.map((row) => ({
          date: row.date,
          branchId: row.branchId,
          branchName: row.branchName,
          revenueSatang: Number(row.revenueSatang),
          cycles: Number(row.cycles)
        }))
      )
    );
  });

  app.get("/api/v1/analytics/cycles/daily", async (c) => {
    const gate = gateAndScope(c);
    if (!gate.ok) return gate.response;
    let rows: DailyRow[];
    try {
      rows = await deps.clickhouse<DailyRow>(DAILY_SQL, gate.params);
    } catch (error) {
      if (error instanceof ClickHouseUnavailableError) {
        return analyticsError(c, 503, "ANALYTICS_SOURCE_UNAVAILABLE", "Analytics warehouse is unavailable");
      }
      throw error;
    }
    return c.json(
      analyticsEnvelope(
        dailyEnvelope(gate.meta, rows),
        rows.map((row) => ({
          date: row.date,
          branchId: row.branchId,
          branchName: row.branchName,
          cycles: Number(row.cycles),
          avgDurationMin: Number(row.avgDurationMin)
        }))
      )
    );
  });
}
