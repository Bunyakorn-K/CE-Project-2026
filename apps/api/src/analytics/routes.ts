import { Hono, type Context } from "hono";
import type { Principal } from "../access-store";
import type { ClickHouseExecutor } from "./clickhouse";
import type { AnalyticsMeta } from "./envelope";
import { buildOpenApiDocument } from "./openapi";
import { registerRevenueRoutes } from "./revenue";
import { parseAnalyticsRange, resolveAnalyticsScope } from "./scope";
import { registerTemperatureRoutes } from "./temperature";
import { registerUtilizationRoutes } from "./utilization";

export type AnalyticsDeps = {
  clickhouse: ClickHouseExecutor;
};

export type AnalyticsAppEnv = { Variables: { principal: Principal | null } };

type AppEnv = AnalyticsAppEnv;

type AnalyticsErrorStatus = 400 | 401 | 403 | 404 | 422 | 502 | 503;

export function analyticsError(c: Context, status: AnalyticsErrorStatus, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

export type Gate =
  | { ok: true; params: { from: string; to: string; branchId: string }; meta: AnalyticsMeta }
  | { ok: false; response: Response };

// Shared pre-query gate for every analytics endpoint: session check, range parse, branch scope.
// Endpoint tasks run their ClickHouse queries with `params` (branchId "" = tenant-wide) and
// overwrite `meta.dataSource` from row counts via analyticsEnvelope.
export function gateAndScope(c: Context<AppEnv>): Gate {
  const principal = c.get("principal");
  if (!principal) {
    return {
      ok: false,
      response: analyticsError(c, 401, "AUTHENTICATION_REQUIRED", "Sign in with an approved LaundryTwin account")
    };
  }
  const range = parseAnalyticsRange(c.req.query("from"), c.req.query("to"), new Date());
  if (!range.ok) return { ok: false, response: analyticsError(c, range.status, range.code, range.message) };
  const scope = resolveAnalyticsScope(principal.grants, c.req.query("branchId"));
  if (!scope.ok) return { ok: false, response: analyticsError(c, scope.status, scope.code, scope.message) };
  return {
    ok: true,
    params: { from: range.value.from, to: range.value.to, branchId: scope.branchId ?? "" },
    meta: { range: range.value, branchId: scope.branchId ?? null, dataSource: "empty" }
  };
}

export function registerAnalyticsRoutes(app: Hono<AppEnv>, deps: AnalyticsDeps) {
  // Session guard shared by every analytics endpoint; concrete endpoints land in Tasks 5-9.
  app.use("/api/v1/analytics/*", async (c, next) => {
    if (!c.get("principal")) {
      return analyticsError(c, 401, "AUTHENTICATION_REQUIRED", "Sign in with an approved LaundryTwin account");
    }
    await next();
  });
  app.get("/api/openapi.json", (c) => c.json(buildOpenApiDocument()));
  registerRevenueRoutes(app, deps);
  registerUtilizationRoutes(app, deps);
  registerTemperatureRoutes(app, deps);
}
