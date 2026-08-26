import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../access-store";
import type { ClickHouseExecutor } from "./clickhouse";
import { ANALYTICS_PATHS, buildOpenApiDocument } from "./openapi";
import { registerAnalyticsRoutes } from "./routes";

export type FakeRow = Record<string, unknown>;
// vitest's Mock type erases generic signatures, so cast to ClickHouseExecutor at the boundary.
export const fakeClickhouse = (rowsByTableHint: { match: RegExp; rows: FakeRow[] }[]): ClickHouseExecutor =>
  vi.fn(async (query: string) => rowsByTableHint.find((entry) => entry.match.test(query))?.rows ?? []) as unknown as ClickHouseExecutor;

const grantsFor = (role: "owner" | "manager" | "technician", branchId: string | null): Principal => ({
  source: "demo",
  user: { id: "u1", name: "Tester", email: "t@example.com" },
  grants: [{ id: "g1", role, branchId }]
});

export function buildTestApp(principal: Principal | null, deps: Parameters<typeof registerAnalyticsRoutes>[1]) {
  const app = new Hono<{ Variables: { principal: Principal | null } }>();
  app.use("/api/v1/analytics/*", async (c, next) => {
    c.set("principal", principal);
    await next();
  });
  registerAnalyticsRoutes(app, deps);
  return app;
}

describe("analytics router skeleton", () => {
  it("requires a session before touching ClickHouse", async () => {
    const clickhouse = fakeClickhouse([]);
    const app = buildTestApp(null, { clickhouse });

    const response = await app.request("/api/v1/analytics/revenue/daily");

    expect(response.status).toBe(401);
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("serves an OpenAPI document covering every registered path", async () => {
    const app = buildTestApp(grantsFor("owner", null), { clickhouse: fakeClickhouse([]) });
    const response = await app.request("/api/openapi.json");
    expect(response.status).toBe(200);

    const document = (await response.json()) as { paths: Record<string, Record<string, unknown>> };
    for (const entry of ANALYTICS_PATHS) {
      expect(document.paths[entry.path]?.[entry.method], `${entry.method} ${entry.path} missing`).toBeTruthy();
    }
  });
});

// keep import used
void buildOpenApiDocument;
