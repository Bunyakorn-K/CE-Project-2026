import { Hono } from "hono";
import { ClickHouseUnavailableError } from "./clickhouse";
import { analyticsEnvelope, dataSourceFromCounts, type AnalyticsMeta } from "./envelope";
import { registerPath } from "./openapi";
import { analyticsError, gateAndScope, type AnalyticsAppEnv, type AnalyticsDeps } from "./routes";

// Fixed SQL template — all user input flows through {from:String}{to:String}{branchId:String}
// bind parameters; nothing is ever concatenated into the query text.
const HEATMAP_SQL = `
SELECT
  toStartOfHour(started_at) AS hourBucket,
  u.machine_id AS machineId,
  m.machine_code AS machineCode,
  sum(duration_min) AS totalDurationMin,
  count() AS cycles,
  countIf(source_event_id LIKE 'synthetic:%') AS synthCount,
  count() AS totalCount
FROM fact_machine_usage AS u
INNER JOIN dim_machine AS m ON (u.tenant_id = m.tenant_id AND u.machine_id = m.machine_id)
WHERE started_at >= {from:String} AND started_at < plus(toDate({to:String}), 1)
  AND ({branchId:String} = '' OR u.branch_id = {branchId:String})
GROUP BY hourBucket, machineId, machineCode
ORDER BY hourBucket, machineCode`;

type HeatmapRow = {
  hourBucket: string;
  machineId: string;
  machineCode: string;
  totalDurationMin: string;
  cycles: string;
  synthCount: string;
  totalCount: string;
};

function heatmapEnvelope(meta: AnalyticsMeta, rows: HeatmapRow[]) {
  const totalRows = rows.reduce((sum, row) => sum + Number(row.totalCount), 0);
  const syntheticRows = rows.reduce((sum, row) => sum + Number(row.synthCount), 0);
  return { ...meta, dataSource: dataSourceFromCounts(totalRows, syntheticRows) };
}

export function registerUtilizationRoutes(app: Hono<AnalyticsAppEnv>, deps: AnalyticsDeps): void {
  registerPath({ path: "/api/v1/analytics/utilization/heatmap", method: "get", summary: "Hourly utilization heatmap: duration minutes and cycles per machine-hour bucket" });

  app.get("/api/v1/analytics/utilization/heatmap", async (c) => {
    const gate = gateAndScope(c);
    if (!gate.ok) return gate.response;
    let rows: HeatmapRow[];
    try {
      rows = await deps.clickhouse<HeatmapRow>(HEATMAP_SQL, gate.params);
    } catch (error) {
      if (error instanceof ClickHouseUnavailableError) {
        return analyticsError(c, 503, "ANALYTICS_SOURCE_UNAVAILABLE", "Analytics warehouse is unavailable");
      }
      throw error;
    }
    return c.json(
      analyticsEnvelope(
        heatmapEnvelope(gate.meta, rows),
        // hourBucket is ClickHouse's toStartOfHour string — returned verbatim.
        rows.map((row) => ({
          hourBucket: row.hourBucket,
          machineId: row.machineId,
          machineCode: row.machineCode,
          totalDurationMin: Number(row.totalDurationMin),
          cycles: Number(row.cycles)
        }))
      )
    );
  });
}
