import { Hono } from "hono";
import { ClickHouseUnavailableError } from "./clickhouse";
import { analyticsEnvelope, dataSourceFromCounts, type AnalyticsMeta } from "./envelope";
import { registerPath } from "./openapi";
import { analyticsError, gateAndScope, type AnalyticsAppEnv, type AnalyticsDeps } from "./routes";

// Fixed SQL template — all user input flows through {from:String}{to:String}{branchId:String}
// and {machineId:String} bind parameters; nothing is ever concatenated into the query text.
// Empty-string sentinels mean "unfiltered"; LIMIT 5000 caps raw sample volume in-template.
const CURVE_SQL = `
SELECT
  occurred_at AS occurredAt,
  s.machine_id AS machineId,
  m.machine_code AS machineCode,
  temperature_f AS temperatureF,
  temperature_c AS temperatureC,
  phase,
  countIf(source_event_id LIKE 'synthetic:%') OVER () AS synthCount,
  count() OVER () AS totalCount
FROM fact_temperature_sample AS s
INNER JOIN dim_machine AS m ON (s.tenant_id = m.tenant_id AND s.machine_id = toString(m.machine_id))
WHERE occurred_at >= {from:String} AND occurred_at < plus(toDate({to:String}), 1)
  AND ({branchId:String} = '' OR s.branch_id = {branchId:String})
  AND ({machineId:String} = '' OR s.machine_id = {machineId:String})
ORDER BY occurred_at ASC
LIMIT 5000`;

type CurveRow = {
  occurredAt: string;
  machineId: string;
  machineCode: string;
  temperatureF: string | null;
  temperatureC: string | null;
  phase: string;
  synthCount: string;
  totalCount: string;
};

function toNumberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function curveEnvelope(meta: AnalyticsMeta, rows: CurveRow[]) {
  const totalRows = rows.reduce((sum, row) => sum + Number(row.totalCount), 0);
  const syntheticRows = rows.reduce((sum, row) => sum + Number(row.synthCount), 0);
  return { ...meta, dataSource: dataSourceFromCounts(totalRows, syntheticRows) };
}

export function registerTemperatureRoutes(app: Hono<AnalyticsAppEnv>, deps: AnalyticsDeps): void {
  registerPath({ path: "/api/v1/analytics/temperature/curve", method: "get", summary: "Raw wash-phase temperature samples per machine (capped at 5000 points)" });

  app.get("/api/v1/analytics/temperature/curve", async (c) => {
    const gate = gateAndScope(c);
    if (!gate.ok) return gate.response;
    const machineId = c.req.query("machineId") ?? "";
    let rows: CurveRow[];
    try {
      rows = await deps.clickhouse<CurveRow>(CURVE_SQL, { ...gate.params, machineId });
    } catch (error) {
      if (error instanceof ClickHouseUnavailableError) {
        return analyticsError(c, 503, "ANALYTICS_SOURCE_UNAVAILABLE", "Analytics warehouse is unavailable");
      }
      throw error;
    }
    return c.json(
      analyticsEnvelope(
        curveEnvelope(gate.meta, rows),
        // Null temperatures pass through untouched — a missing reading is not zero.
        rows.map((row) => ({
          occurredAt: row.occurredAt,
          machineId: row.machineId,
          machineCode: row.machineCode,
          temperatureF: toNumberOrNull(row.temperatureF),
          temperatureC: toNumberOrNull(row.temperatureC),
          phase: row.phase
        }))
      )
    );
  });
}
