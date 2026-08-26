# Analytics Dev Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow-listed `/api/v1/analytics/*` KPI/chart/heatmap endpoints on the existing Hono API querying ClickHouse, a Scalar/OpenAPI playground at `/docs`, labeled synthetic seed data, and TMD weather forecast integration for the Phase 2 correlation endpoint.

**Architecture:** New self-contained `apps/api/src/analytics/` module mounted into the existing app after the auth middleware. A minimal `fetch`-based ClickHouse HTTP client and a TMD client are injected through `AppDependencies` so every route is unit-testable with fakes. Superset stays the BI exploration surface; this API layer is the product surface.

**Tech Stack:** Hono 4, TypeScript, vitest, ClickHouse HTTP (port 8123, JSONEachRow), TMD NWP API v1, `@scalar/hono-api-reference`.

**Spec:** `docs/superpowers/specs/2026-08-26-analytics-dev-platform-design.md`

## Global Constraints

- Node.js 22+, pnpm 10+. Run tests with `pnpm --filter @laundrytwin/api test`; typecheck with `pnpm check && pnpm build`.
- Money stays integer satang end to end. Presentation divides by 100.
- All ClickHouse queries are fixed templates with `{name:String}` parameters bound via URL `param_*` values. Never interpolate user input into SQL text.
- Synthetic rows always have `source_event_id` starting with `synthetic:`. Endpoints report `meta.dataSource` as `"synthetic" | "real" | "mixed" | "empty"`; never auto-substitute synthetic for missing real data.
- The browser never receives `TMD_API_TOKEN`, `CLICKHOUSE_PASSWORD`, or any upstream credential.
- Fail closed: unconfigured provider → 503 typed error, no fabricated data.
- Commit as `uunw <uunw@proton.me>`. Preserve unrelated working-tree changes — stage only files listed in each task.
- Existing repo conventions: error envelope `{ error: { code, message } }`, routes read principal via `c.get("principal")`, pure RBAC helpers in `access-policy.ts`.

---

### Task 1: ClickHouse HTTP client

**Files:**
- Create: `apps/api/src/analytics/clickhouse.ts`
- Test: `apps/api/src/analytics/clickhouse.test.ts`
- Modify: `.env.example`, `deploy/.env.production.example` (append placeholder keys only)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export class ClickHouseUnavailableError extends Error {}
  export type ClickHouseExecutor = <T extends Record<string, unknown>>(
    query: string,
    params?: Record<string, string | number>
  ) => Promise<T[]>;
  export type ClickHouseClientConfig = {
    url?: string; user?: string; password?: string; database?: string;
    fetchImpl?: typeof fetch;
  };
  export function createClickHouseClient(config: ClickHouseClientConfig = {}): ClickHouseExecutor
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/analytics/clickhouse.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClickHouseUnavailableError, createClickHouseClient } from "./clickhouse";

const okResponse = (rows: unknown[]) =>
  new Response(rows.map((row) => JSON.stringify(row)).join("\n"), { status: 200 });

describe("clickhouse client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts the query body with bound params and parses JSONEachRow", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse([{ date: "2026-08-01", revenueSatang: 1200 }, { date: "2026-08-02", revenueSatang: 900 }])
    );
    const query = createClickHouseClient({ url: "http://ch:8123", user: "u", password: "p", database: "laundrytwin_analytics", fetchImpl });

    const rows = await query<{ date: string; revenueSatang: number }>(
      "SELECT toDate(started_at) AS date FROM fact_machine_usage WHERE started_at >= {from:String}",
      { from: "2026-08-01" }
    );

    expect(rows).toHaveLength(2);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://ch:8123/?database=laundrytwin_analytics&default_format=JSONEachRow&param_from=2026-08-01");
    expect(init.headers).toMatchObject({ Authorization: "Basic " + Buffer.from("u:p").toString("base64") });
    expect(String(init.body)).toContain("fact_machine_usage");
  });

  it("maps network failures to ClickHouseUnavailableError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const query = createClickHouseClient({ fetchImpl });
    await expect(query("SELECT 1")).rejects.toBeInstanceOf(ClickHouseUnavailableError);
  });

  it("maps non-2xx responses to ClickHouseUnavailableError without leaking the SQL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("secret-secret FROM users", { status: 403 }));
    const query = createClickHouseClient({ fetchImpl });
    await expect(query("SELECT secret_col FROM users")).rejects.toThrow(/ClickHouse request failed with status 403/);
    await expect(query("SELECT secret_col FROM users")).rejects.not.toThrow(/secret_col/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/analytics/clickhouse.test.ts`
Expected: FAIL, module `./clickhouse` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/analytics/clickhouse.ts
export class ClickHouseUnavailableError extends Error {}

export type ClickHouseExecutor = <T extends Record<string, unknown>>(
  query: string,
  params?: Record<string, string | number>
) => Promise<T[]>;

export type ClickHouseClientConfig = {
  url?: string;
  user?: string;
  password?: string;
  database?: string;
  fetchImpl?: typeof fetch;
};

export function createClickHouseClient(config: ClickHouseClientConfig = {}): ClickHouseExecutor {
  const url = config.url ?? process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
  const user = config.user ?? process.env.CLICKHOUSE_USER ?? "default";
  const password = config.password ?? process.env.CLICKHOUSE_PASSWORD ?? "";
  const database = config.database ?? process.env.CLICKHOUSE_DATABASE ?? "laundrytwin_analytics";
  const doFetch = config.fetchImpl ?? fetch;

  return async function query<T extends Record<string, unknown>>(queryText, params = {}) {
    const search = new URLSearchParams({ database, default_format: "JSONEachRow" });
    for (const [name, value] of Object.entries(params)) search.set(`param_${name}`, String(value));
    let response: Response;
    try {
      response = await doFetch(`${url.replace(/\/$/, "")}/?${search.toString()}`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` },
        body: queryText
      });
    } catch {
      throw new ClickHouseUnavailableError("ClickHouse is unreachable");
    }
    if (!response.ok) {
      throw new ClickHouseUnavailableError(`ClickHouse request failed with status ${response.status}`);
    }
    const text = await response.text();
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/analytics/clickhouse.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add env placeholders**

Append to `.env.example` and `deploy/.env.production.example` (placeholders only, never real values):

```bash
# Analytics warehouse (ClickHouse HTTP interface)
CLICKHOUSE_URL=http://127.0.0.1:8123
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=
CLICKHOUSE_DATABASE=laundrytwin_analytics
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/analytics/clickhouse.ts apps/api/src/analytics/clickhouse.test.ts .env.example deploy/.env.production.example
git commit -m "feat(api): add parameterized ClickHouse HTTP client"
```

---

### Task 2: Scope + range policy helpers

**Files:**
- Create: `apps/api/src/analytics/scope.ts`
- Test: `apps/api/src/analytics/scope.test.ts`

**Interfaces:**
- Consumes: `AccessGrant` from `../access-policy`.
- Produces:
  ```ts
  export type ScopeResult =
    | { ok: true; branchId?: string }
    | { ok: false; status: 400 | 403; code: string; message: string };
  export function resolveAnalyticsScope(grants: AccessGrant[], requestedBranchId?: string): ScopeResult
  export type AnalyticsRange = { from: string; to: string }; // YYYY-MM-DD
  export function parseAnalyticsRange(from: string | undefined, to: string | undefined, now: Date): { ok: true; value: AnalyticsRange } | { ok: false; status: 400; code: string; message: string }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/analytics/scope.test.ts
import { describe, expect, it } from "vitest";
import type { AccessGrant } from "../access-policy";
import { parseAnalyticsRange, resolveAnalyticsScope } from "./scope";

const grant = (role: AccessGrant["role"], branchId: string | null): AccessGrant => ({ id: `${role}-${branchId}`, role, branchId });

describe("resolveAnalyticsScope", () => {
  it("accepts a requested branch inside the grant list", () => {
    const result = resolveAnalyticsScope([grant("manager", "b1")], "b1");
    expect(result).toEqual({ ok: true, branchId: "b1" });
  });

  it("denies a requested branch outside the grant list with 403", () => {
    const result = resolveAnalyticsScope([grant("technician", "b1")], "b2");
    expect(result).toEqual({ ok: false, status: 403, code: "BRANCH_FORBIDDEN", message: "You cannot view this branch" });
  });

  it("returns tenant-wide scope for an owner when no branch requested", () => {
    expect(resolveAnalyticsScope([grant("owner", null)])).toEqual({ ok: true, branchId: undefined });
  });

  it("auto-scopes to the single granted branch", () => {
    expect(resolveAnalyticsScope([grant("technician", "b1")])).toEqual({ ok: true, branchId: "b1" });
  });

  it("asks for a branch when several are granted and none requested", () => {
    const result = resolveAnalyticsScope([grant("technician", "b1"), grant("technician", "b2")]);
    expect(result).toEqual({ ok: false, status: 400, code: "BRANCH_REQUIRED", message: "Choose a branch before loading analytics" });
  });
});

describe("parseAnalyticsRange", () => {
  const now = new Date("2026-08-26T00:00:00Z");

  it("defaults to the last 30 days", () => {
    const result = parseAnalyticsRange(undefined, undefined, now);
    expect(result.ok && result.value).toEqual({ from: "2026-07-27", to: "2026-08-26" });
  });

  it("accepts explicit ISO dates", () => {
    expect(parseAnalyticsRange("2026-08-01", "2026-08-10", now)).toEqual({
      ok: true,
      value: { from: "2026-08-01", to: "2026-08-10" }
    });
  });

  it("rejects malformed dates and inverted ranges", () => {
    expect(parseAnalyticsRange("2026-13-01", "2026-08-10", now).ok).toBe(false);
    expect(parseAnalyticsRange("2026-08-10", "2026-08-01", now)).toEqual({
      ok: false, status: 400, code: "INVALID_RANGE", message: "from must be before to"
    });
  });

  it("caps the window at 90 days", () => {
    const result = parseAnalyticsRange("2026-01-01", "2026-08-26", now);
    expect(result).toEqual({ ok: false, status: 400, code: "RANGE_TOO_LONG", message: "Analytics range is capped at 90 days" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/analytics/scope.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/analytics/scope.ts
import { canAccessBranch, type AccessGrant } from "../access-policy";

export type ScopeResult =
  | { ok: true; branchId?: string }
  | { ok: false; status: 400 | 403; code: string; message: string };

export function resolveAnalyticsScope(grants: AccessGrant[], requestedBranchId?: string): ScopeResult {
  if (requestedBranchId) {
    return canAccessBranch(grants, requestedBranchId)
      ? { ok: true, branchId: requestedBranchId }
      : { ok: false, status: 403, code: "BRANCH_FORBIDDEN", message: "You cannot view this branch" };
  }
  if (grants.some((grant) => grant.role === "owner")) return { ok: true, branchId: undefined };

  const grantedBranches = [...new Set(grants.flatMap((grant) => (grant.branchId ? [grant.branchId] : [])))];
  return grantedBranches.length === 1
    ? { ok: true, branchId: grantedBranches[0] }
    : { ok: false, status: 400, code: "BRANCH_REQUIRED", message: "Choose a branch before loading analytics" };
}

export type AnalyticsRange = { from: string; to: string };

export type RangeResult =
  | { ok: true; value: AnalyticsRange }
  | { ok: false; status: 400; code: string; message: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function parseAnalyticsRange(from: string | undefined, to: string | undefined, now: Date): RangeResult {
  if (Boolean(from) !== Boolean(to)) {
    return { ok: false, status: 400, code: "INVALID_RANGE", message: "from and to must be supplied together" };
  }
  if (!from || !to) {
    return { ok: true, value: { from: toIsoDate(new Date(now.getTime() - 30 * DAY_MS)), to: toIsoDate(now) } };
  }
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return { ok: false, status: 400, code: "INVALID_RANGE", message: "from and to must be YYYY-MM-DD dates" };
  }
  if (Date.parse(from) > Date.parse(to)) {
    return { ok: false, status: 400, code: "INVALID_RANGE", message: "from must be before to" };
  }
  if (Date.parse(to) - Date.parse(from) > 90 * DAY_MS) {
    return { ok: false, status: 400, code: "RANGE_TOO_LONG", message: "Analytics range is capped at 90 days" };
  }
  return { ok: true, value: { from, to } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/analytics/scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/analytics/scope.ts apps/api/src/analytics/scope.test.ts
git commit -m "feat(api): add analytics scope and range policy helpers"
```

---

### Task 3: Router skeleton, envelope helper, OpenAPI + Scalar playground

**Files:**
- Create: `apps/api/src/analytics/envelope.ts`, `apps/api/src/analytics/routes.ts`, `apps/api/src/analytics/openapi.ts`
- Modify: `apps/api/package.json` (add `@scalar/hono-api-reference`), `apps/api/src/index.ts`
- Test: `apps/api/src/analytics/routes.test.ts`

**Interfaces:**
- Consumes: `ClickHouseExecutor` (Task 1), `resolveAnalyticsScope` / `parseAnalyticsRange` (Task 2), `Principal` type from `../access-store`.
- Produces (used by Tasks 4–9):
  ```ts
  // envelope.ts
  export type DataSourceTag = "synthetic" | "real" | "mixed" | "empty";
  export type AnalyticsMeta = { range: { from: string; to: string }; branchId: string | null; dataSource: DataSourceTag };
  export function analyticsEnvelope<T>(meta: Omit<AnalyticsMeta, "dataSource"> & { dataSource: DataSourceTag }, data: T[]): { meta: AnalyticsMeta; data: T[] };
  export function dataSourceFromCounts(totalRows: number, syntheticRows: number): DataSourceTag;
  // routes.ts
  export type AnalyticsDeps = { clickhouse: ClickHouseExecutor };
  export function registerAnalyticsRoutes(app: Hono<{ Variables: { principal: Principal | null } }>, deps: AnalyticsDeps): void;
  ```
  Task 5 extends `AnalyticsDeps` with `branchLocationStore`; Task 7 adds `tmd`. Route paths registered here as constants in `openapi.ts`:
  ```ts
  export const ANALYTICS_PATHS: { path: string; method: "get"; summary: string }[] // grows per task
  ```

- [ ] **Step 1: Install Scalar**

Run: `pnpm --filter @laundrytwin/api add @scalar/hono-api-reference`
Expected: package added to `dependencies`.

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/src/analytics/routes.test.ts
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../access-store";
import { ANALYTICS_PATHS, buildOpenApiDocument } from "./openapi";
import { registerAnalyticsRoutes } from "./routes";

export type FakeRow = Record<string, unknown>;
export const fakeClickhouse = (rowsByTableHint: { match: RegExp; rows: FakeRow[] }[]) =>
  vi.fn(async (query: string) => rowsByTableHint.find((entry) => entry.match.test(query))?.rows ?? []);

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
```

Note: `Principal` shape — check `apps/api/src/access-store.ts` for the exact exported type before writing; adjust `grantsFor` to satisfy it (it currently returns `{ source, user, grants }`).

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/analytics/routes.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement envelope, openapi registry, skeleton routes**

```ts
// apps/api/src/analytics/envelope.ts
export type DataSourceTag = "synthetic" | "real" | "mixed" | "empty";

export type AnalyticsMeta = {
  range: { from: string; to: string };
  branchId: string | null;
  dataSource: DataSourceTag;
};

export function dataSourceFromCounts(totalRows: number, syntheticRows: number): DataSourceTag {
  if (totalRows === 0) return "empty";
  if (syntheticRows === 0) return "real";
  if (syntheticRows === totalRows) return "synthetic";
  return "mixed";
}

export function analyticsEnvelope<T>(meta: AnalyticsMeta, data: T[]) {
  return { meta, data };
}
```

```ts
// apps/api/src/analytics/openapi.ts
export const ANALYTICS_PATHS: { path: string; method: "get"; summary: string }[] = [];

export function registerPath(entry: { path: string; method: "get"; summary: string }) {
  ANALYTICS_PATHS.push(entry);
}

export function buildOpenApiDocument() {
  return {
    openapi: "3.0.3",
    info: {
      title: "LaundryTwin Analytics API",
      version: "1.0.0",
      description:
        "Allow-listed analytics endpoints over ClickHouse. Session cookie required (Better Auth, LIFF, or demo session). Revenue endpoints require owner/manager."
    },
    paths: Object.fromEntries(
      ANALYTICS_PATHS.map((entry) => [entry.path, { [entry.method]: { summary: entry.summary, responses: { "200": { description: "Analytics envelope" } } } }])
    )
  };
}
```

```ts
// apps/api/src/analytics/routes.ts
import type { Context } from "hono";
import type { Principal } from "../access-store";
import type { ClickHouseExecutor } from "./clickhouse";

export type AnalyticsDeps = {
  clickhouse: ClickHouseExecutor;
};

type AppEnv = { Variables: { principal: Principal | null } };

export function requirePrincipal(c: Context<AppEnv>): Principal | Response | null {
  return c.get("principal");
}

export function registerAnalyticsRoutes(app: Hono<AppEnv>, deps: AnalyticsDeps) {
  void deps;
  void requirePrincipal;
}
```

(`Hono` imported from `"hono"`.) Wire into `index.ts`: extend `AppDependencies` with `analyticsDeps?: AnalyticsDeps`, then after the auth middleware block (`app.use("/api/*", ...)` around line 154) add:

```ts
import { registerAnalyticsRoutes, type AnalyticsDeps } from "./analytics/routes";
// inside createApp, after the auth middleware:
registerAnalyticsRoutes(app, dependencies.analyticsDeps ?? { clickhouse: createClickHouseClient() });
```

Also in `createApp`, mount the playground (before `return app`):

```ts
app.get("/api/openapi.json", (c) => c.json(buildOpenApiDocument()));
app.get("/docs", apiReference({ spec: { url: "/api/openapi.json" } }));
```

with imports `import { apiReference } from "@scalar/hono-api-reference";` and `import { buildOpenApiDocument } from "./analytics/openapi";`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/analytics/routes.test.ts`
Expected: PASS (session guard + OpenAPI contract test; `ANALYTICS_PATHS` empty so loop trivially passes — later tasks push entries and the contract tightens automatically).

- [ ] **Step 6: Full suite green**

Run: `pnpm --filter @laundrytwin/api test`
Expected: all existing tests still pass (index.ts change is additive; `/docs` and `/api/openapi.json` need no auth by design).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/analytics/envelope.ts apps/api/src/analytics/openapi.ts apps/api/src/analytics/routes.ts apps/api/src/analytics/routes.test.ts apps/api/src/index.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): mount analytics router skeleton with Scalar playground"
```

---

### Task 4: Synthetic seed script

**Files:**
- Create: `apps/api/scripts/seed-analytics.ts`
- Test: `apps/api/scripts/seed-analytics.test.ts`

**Interfaces:**
- Consumes: `ClickHouseExecutor` shape (Task 1) — the script accepts an executor for testability.
- Produces:
  ```ts
  export const SEED_BRANCHES: { tenantId: string; branchId: string; name: string }[];
  export function buildSeedRows(seed: number, days: number): {
    branches: Record<string, unknown>[]; machines: Record<string, unknown>[]; usage: Record<string, unknown>[];
  };
  export function shouldRefuseSeed(existingRealRowCount: number, force: boolean): boolean;
  export async function runSeed(executor: ClickHouseExecutor, options?: { days?: number }): Promise<void>;
  ```
  Determinism contract: same `seed` → byte-identical rows. PRNG: mulberry32.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/scripts/seed-analytics.test.ts
import { describe, expect, it } from "vitest";
import { buildSeedRows, shouldRefuseSeed } from "./seed-analytics";

describe("seed-analytics", () => {
  it("builds deterministic rows for a fixed seed", () => {
    expect(buildSeedRows(20260826, 60)).toEqual(buildSeedRows(20260826, 60));
  });

  it("tags every usage row with a synthetic source_event_id", () => {
    const { usage } = buildSeedRows(20260826, 30);
    expect(usage.length).toBeGreaterThan(0);
    for (const row of usage) expect(String(row.source_event_id)).toMatch(/^synthetic:/);
  });

  it("keeps amounts as integer satang and weekday-skewed hours", () => {
    const { usage } = buildSeedRows(20260826, 30);
    for (const row of usage) {
      expect(Number.isInteger(row.amount_satang)).toBe(true);
      expect(row.amount_satang).toBeGreaterThan(0);
    }
  });

  it("refuses to seed over real data unless forced", () => {
    expect(shouldRefuseSeed(5, false)).toBe(true);
    expect(shouldRefuseSeed(5, true)).toBe(false);
    expect(shouldRefuseSeed(0, false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @laundrytwin/api exec vitest run scripts/seed-analytics.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/api/scripts/seed-analytics.ts
import "../src/config";
import { createClickHouseClient, type ClickHouseExecutor } from "../src/analytics/clickhouse";

export const SEED_BRANCHES = [
  { tenantId: "00000000-0000-4000-8000-000000000001", branchId: "10000000-0000-4000-8000-000000000001", name: "SYNTH-Rama II" },
  { tenantId: "00000000-0000-4000-8000-000000000001", branchId: "10000000-0000-4000-8000-000000000002", name: "SYNTH-Bang Khae" }
];

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let counter = 0;
function synthId(rand: () => number) {
  counter += 1;
  return `synthetic:${Math.floor(rand() * 1e12).toString(16).padStart(11, "0")}${counter}`;
}

export function shouldRefuseSeed(existingRealRowCount: number, force: boolean) {
  return existingRealRowCount > 0 && !force;
}

export function buildSeedRows(seed: number, days: number) {
  counter = 0;
  const rand = mulberry32(seed);
  const machines = SEED_BRANCHES.flatMap((branch, bi) =>
    ["washer", "washer", "dryer"].map((kind, mi) => ({
      tenant_id: branch.tenantId,
      branch_id: branch.branchId,
      machine_id: `20000000-0000-4000-8000-${String(bi)}${mi}000000000000`.slice(0, 36),
      machine_code: `SYNTH-${bi + 1}-${kind.slice(0, 1).toUpperCase()}${mi + 1}`,
      machine_kind: kind,
      modbus_address: bi * 10 + mi + 1,
      active: 1,
      source_updated_at: "2026-08-26 00:00:00.000",
      extracted_at: "2026-08-26 00:00:00.000"
    }))
  );
  const branches = SEED_BRANCHES.map((branch) => ({
    tenant_id: branch.tenantId,
    branch_id: branch.branchId,
    branch_name: branch.name,
    timezone: "Asia/Bangkok",
    active: 1,
    source_updated_at: "2026-08-26 00:00:00.000",
    extracted_at: "2026-08-26 00:00:00.000"
  }));

  const usage: Record<string, unknown>[] = [];
  const end = Date.UTC(2026, 7, 26);
  for (let dayOffset = days; dayOffset > 0; dayOffset -= 1) {
    const dayStart = end - dayOffset * 86_400_000;
    const dow = new Date(dayStart).getUTCDay();
    const cyclesToday = 20 + Math.floor(rand() * (dow === 0 || dow === 6 ? 30 : 15));
    for (let i = 0; i < cyclesToday; i += 1) {
      const hourSkew = rand() < 0.55 ? 9 + Math.floor(rand() * 6) : 15 + Math.floor(rand() * 7);
      const startedAt = new Date(dayStart + hourSkew * 3_600_000 + Math.floor(rand() * 3_600_000));
      const durationMin = 30 + Math.floor(rand() * 40);
      const machine = machines[Math.floor(rand() * machines.length)]!;
      const amountSatang = (machine.machine_kind === "dryer" ? 2000 : 4000) + Math.floor(rand()) * 500;
      usage.push({
        tenant_id: String(machine.tenant_id),
        branch_id: String(machine.branch_id),
        machine_id: String(machine.machine_id),
        usage_id: synthId(rand),
        source_event_id: synthId(rand),
        machine_session_id: null,
        started_at: startedAt.toISOString().replace("T", " ").slice(0, 23),
        finished_at: new Date(startedAt.getTime() + durationMin * 60_000).toISOString().replace("T", " ").slice(0, 23),
        duration_min: durationMin,
        program_id: 1 + Math.floor(rand() * 3),
        program_name: ["quick", "standard", "heavy"][Math.floor(rand() * 3)],
        temp_level: machine.machine_kind === "dryer" ? "high" : ["cold", "warm", "hot"][Math.floor(rand() * 3)],
        amount_satang: Math.round(amountSatang),
        status: rand() < 0.92 ? "finished" : "cancelled",
        initiated_via: rand() < 0.5 ? "liff" : "staff_v3",
        attribution_state: "exact",
        attribution_source: "liff",
        source_created_at: startedAt.toISOString().replace("T", " ").slice(0, 23),
        source_updated_at: startedAt.toISOString().replace("T", " ").slice(0, 23),
        extracted_at: "2026-08-26 00:00:00.000"
      });
    }
  }

  return { branches, machines, usage };
}

export async function runSeed(executor: ClickHouseExecutor, options: { force?: boolean; days?: number } = {}) {
  const countRows = await executor<{ real_count: number }>(
    "SELECT countIf(NOT startsWith(source_event_id, 'synthetic:')) AS real_count FROM fact_machine_usage"
  );
  if (shouldRefuseSeed(countRows[0]?.real_count ?? 0, Boolean(options.force))) {
    throw new Error("Refusing to seed: fact_machine_usage contains non-synthetic rows. Re-run with --force to allow.");
  }
  const { branches, machines, usage } = buildSeedRows(20260826, options.days ?? 60);
  await insertRows(executor, "dim_branch", branches);
  await insertRows(executor, "dim_machine", machines);
  await insertRows(executor, "fact_machine_usage", usage);
  console.log(`Seeded ${branches.length} branches, ${machines.length} machines, ${usage.length} synthetic usage rows.`);
}

async function insertRows(executor: ClickHouseExecutor, table: string, rows: Record<string, unknown>[]) {
  for (let offset = 0; offset < rows.length; offset += 500) {
    const chunk = rows.slice(offset, offset + 500);
    const payload = chunk.map((row) => JSON.stringify(row)).join("\n");
    await executor(`INSERT INTO ${table} FORMAT JSONEachRow\n${payload}`);
  }
}

const invokedDirectly = process.argv[1]?.endsWith("seed-analytics.ts");
if (invokedDirectly) {
  runSeed(createClickHouseClient(), { force: process.argv.includes("--force") }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
```

Note: `insertRows` sends the INSERT statement including inline JSON payload as one POST body — acceptable because content is script-generated, never user input. Keep that comment in the file.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @laundrytwin/api exec vitest run scripts/seed-analytics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/scripts/seed-analytics.ts apps/api/scripts/seed-analytics.test.ts
git commit -m "feat(api): add deterministic synthetic ClickHouse seed script"
```

---

### Task 5: Revenue + cycles daily endpoints

**Files:**
- Create: `apps/api/src/analytics/revenue.ts`
- Modify: `apps/api/src/analytics/routes.ts`, `apps/api/src/analytics/openapi.ts`
- Test: `apps/api/src/analytics/revenue.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `GET /api/v1/analytics/revenue/daily?from&to&branchId` → `{ meta, data: [{ date, branchId, branchName, revenueSatang, cycles }] }` (owner/manager only)
  - `GET /api/v1/analytics/cycles/daily?...` → `{ meta, data: [{ date, branchId, branchName, cycles, avgDurationMin }] }`
  ```ts
  export function registerRevenueRoutes(app: Hono<AnalyticsAppEnv>, deps: AnalyticsDeps): void
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/analytics/revenue.test.ts
import { describe, expect, it, vi } from "vitest";
import { buildTestApp, fakeClickhouse } from "./routes.test";

const usageRows = [
  { date: "2026-08-01", branchId: "b1", branchName: "SYNTH-A", revenueSatang: "184000", cycles: "31", synthCount: "31", totalCount: "31", avgDurationMin: "38.2" },
  { date: "2026-08-02", branchId: "b1", branchName: "SYNTH-A", revenueSatang: "126500", cycles: "24", synthCount: "0", totalCount: "24", avgDurationMin: "35.0" }
];

describe("revenue + cycles endpoints", () => {
  it("returns satang integers with synthetic meta for owner", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_machine_usage/, rows: usageRows }]);
    const app = buildTestApp({ source: "demo", user: { id: "u1", name: "T", email: "t@e.com" }, grants: [{ id: "g", role: "owner", branchId: null }] }, { clickhouse });

    const response = await app.request("/api/v1/analytics/revenue/daily?from=2026-08-01&to=2026-08-31");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data[0]).toEqual({ date: "2026-08-01", branchId: "b1", branchName: "SYNTH-A", revenueSatang: 184000, cycles: 31 });
    expect(body.meta.dataSource).toBe("synthetic"); // first row all-synthetic drives mixed? see note below
  });

  it("denies revenue to technicians with REVENUE_FORBIDDEN and never queries", async () => {
    const clickhouse = fakeClickhouse([{ match: /./, rows: [] }]);
    const app = buildTestApp({ source: "demo", user: { id: "u1", name: "T", email: "t@e.com" }, grants: [{ id: "g", role: "technician", branchId: "b1" }] }, { clickhouse });

    const response = await app.request("/api/v1/analytics/revenue/daily");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: { code: "REVENUE_FORBIDDEN", message: "Revenue analytics requires an owner or manager role" } });
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("cycles endpoint is available to technicians within their branch", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_machine_usage/, rows: usageRows.map((r) => ({ ...r, synthCount: "0" })) }]);
    const app = buildTestApp({ source: "demo", user: { id: "u1", name: "T", email: "t@e.com" }, grants: [{ id: "g", role: "technician", branchId: "b1" }] }, { clickhouse });

    const response = await app.request("/api/v1/analytics/cycles/daily?branchId=b1");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meta.dataSource).toBe("real");
    expect(body.data[0].avgDurationMin).toBeCloseTo(38.2, 1);
  });
});
```

Adjust the first assertion during implementation: `dataSourceFromCounts` computes across the whole window, so make the fixture coherent — either all-synthetic or mixed counts — and assert accordingly (the rule under test is the mapping, not the fixture). Keep one case per tag where practical.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/analytics/revenue.test.ts`
Expected: FAIL (404 — route not registered).

- [ ] **Step 3: Implement**

```ts
// apps/api/src/analytics/revenue.ts
import { mayViewRevenue, type AccessGrant } from "../access-policy";
import { analyticsEnvelope, dataSourceFromCounts } from "./envelope";
import { registerPath } from "./openapi";
import { parseAnalyticsRange, resolveAnalyticsScope } from "./scope";
import { analyticsError, requirePrincipal, type AnalyticsAppEnv, type AnalyticsDeps } from "./routes";

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
  date: string; branchId: string; branchName: string;
  revenueSatang: string; cycles: string; avgDurationMin: string;
  synthCount: string; totalCount: string;
};

export function registerRevenueRoutes(app: AnalyticsAppEnv extends infer _E ? import("hono").Hono<{ Variables: { principal: import("../access-store").Principal | null } }> : never, deps: AnalyticsDeps) {
  registerPath({ path: "/api/v1/analytics/revenue/daily", method: "get", summary: "Daily gross revenue and cycles per branch (satang)" });
  registerPath({ path: "/api/v1/analytics/cycles/daily", method: "get", summary: "Daily cycle counts and average duration per branch" });

  app.get("/api/v1/analytics/revenue/daily", async (c) => {
    const gate = gateAndScope(c);
    if (!gate.ok) return gate.response;
    if (!mayViewRevenue(c.get("principal")!.grants)) {
      return analyticsError(c, 403, "REVENUE_FORBIDDEN", "Revenue analytics requires an owner or manager role");
    }
    const rows = await deps.clickhouse<DailyRow>(gate.sql, gate.params);
    return c.json(analyticsEnvelope(gate.meta, rows.map((row) => ({
      date: row.date,
      branchId: row.branchId,
      branchName: row.branchName,
      revenueSatang: Number(row.revenueSatang),
      cycles: Number(row.cycles)
    }))));
  });

  app.get("/api/v1/analytics/cycles/daily", async (c) => {
    const gate = gateAndScope(c);
    if (!gate.ok) return gate.response;
    const rows = await deps.clickhouse<DailyRow>(gate.sql, gate.params);
    return c.json(analyticsEnvelope(gate.meta, rows.map((row) => ({
      date: row.date,
      branchId: row.branchId,
      branchName: row.branchName,
      cycles: Number(row.cycles),
      avgDurationMin: Number(row.avgDurationMin)
    }))));
  });
}
```

The shared gate lives in `routes.ts`:

```ts
// appended to apps/api/src/analytics/routes.ts
import { analyticsEnvelope, dataSourceFromCounts } from "./envelope";
import { parseAnalyticsRange, resolveAnalyticsScope } from "./scope";
import { ClickHouseUnavailableError } from "./clickhouse";

export type AnalyticsAppEnv = { Variables: { principal: Principal | null } };

export function analyticsError(c: Context<AnalyticsAppEnv>, status: 400 | 401 | 403 | 404 | 422 | 502 | 503, code: string, message: string) {
  return c.json({ error: { code, message } }, status as 400);
}

type Gate =
  | { ok: true; sql: string; params: Record<string, string>; meta: ReturnType<typeof analyticsEnvelope> extends never ? never : import("./envelope").AnalyticsMeta }
  | { ok: false; response: Response };

export function gateAndScope(c: Context<AnalyticsAppEnv>): Gate {
  const principal = c.get("principal");
  if (!principal) {
    return { ok: false, response: analyticsError(c, 401, "AUTHENTICATION_REQUIRED", "Sign in with an approved LaundryTwin account") };
  }
  const range = parseAnalyticsRange(c.req.query("from"), c.req.query("to"), new Date());
  if (!range.ok) {
    return { ok: false, response: analyticsError(c, range.status, range.code, range.message) };
  }
  const scope = resolveAnalyticsScope(principal.grants, c.req.query("branchId"));
  if (!scope.ok) {
    return { ok: false, response: analyticsError(c, scope.status, scope.code, scope.message) };
  }
  return {
    ok: true,
    sql: "",
    params: {},
    meta: { range: range.value, branchId: scope.branchId ?? null, dataSource: "empty" }
  } satisfies Gate as Gate;
}
```

Simplify while implementing: define `Gate`'s meta field as `AnalyticsMeta` directly (import the type), fill `sql`/`params` per-route via a small builder rather than the awkward conditional types shown — the intent above is the shape; write it cleanly:

```ts
// final clean form to use
export type Gate =
  | { ok: true; params: { from: string; to: string; branchId: string }; meta: AnalyticsMeta }
  | { ok: false; response: Response };
```

Routes then interpolate only their own fixed SQL template with `gate.params.from/to/branchId` bound as `{...:String}` parameters (never string-interpolated into SQL). Wrap `deps.clickhouse(...)` calls in try/catch mapping `ClickHouseUnavailableError` to `analyticsError(c, 503, "ANALYTICS_SOURCE_UNAVAILABLE", "Analytics warehouse is unavailable")`. Register both route modules from `registerAnalyticsRoutes`:

```ts
export function registerAnalyticsRoutes(app: Hono<AnalyticsAppEnv>, deps: AnalyticsDeps) {
  registerRevenueRoutes(app, deps);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @laundrytwin/api exec vitest run src/analytics/revenue.test.ts src/analytics/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/analytics/revenue.ts apps/api/src/analytics/revenue.test.ts apps/api/src/analytics/routes.ts apps/api/src/analytics/openapi.ts
git commit -m "feat(api): add revenue and cycles daily analytics endpoints"
```

---

### Task 6: Utilization heatmap + temperature curve

**Files:**
- Create: `apps/api/src/analytics/utilization.ts`, `apps/api/src/analytics/temperature.ts`
- Modify: `apps/api/src/analytics/routes.ts`, `apps/api/src/analytics/openapi.ts`
- Test: `apps/api/src/analytics/utilization.test.ts`, `apps/api/src/analytics/temperature.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/v1/analytics/utilization/heatmap?from&to&branchId` → `{ meta, data: [{ hourBucket, machineId, machineCode, totalDurationMin, cycles }] }`
  - `GET /api/v1/analytics/temperature/curve?from&to&branchId&machineId?` → `{ meta, data: [{ occurredAt, machineId, machineCode, temperatureF, temperatureC, phase }] }` (LIMIT 5000)

- [ ] **Step 1: Write failing tests** (same `buildTestApp` harness; technician allowed, cross-branch 403, envelope meta asserted; fixtures exercise `dataSourceFromCounts`)
  Heatmap fixture rows: `{ hourBucket: "2026-08-01 09:00:00", machineId: "m1", machineCode: "W-1", totalDurationMin: "240", cycles: "6", synthCount: "6", totalCount: "6" }`. Temperature fixture rows include `temperatureC: null` case asserting passthrough of null.

SQL templates (fixed):

```sql
-- heatmap
SELECT toStartOfHour(started_at) AS hourBucket, u.machine_id AS machineId,
       m.machine_code AS machineCode, sum(duration_min) AS totalDurationMin,
       count() AS cycles,
       countIf(source_event_id LIKE 'synthetic:%') AS synthCount, count() AS totalCount
FROM fact_machine_usage AS u
INNER JOIN dim_machine AS m ON (u.tenant_id = m.tenant_id AND u.machine_id = m.machine_id)
WHERE started_at >= {from:String} AND started_at < plus(toDate({to:String}), 1)
  AND ({branchId:String} = '' OR u.branch_id = {branchId:String})
GROUP BY hourBucket, machineId, machineCode ORDER BY hourBucket, machineCode

-- temperature curve
SELECT occurred_at AS occurredAt, s.machine_id AS machineId, m.machine_code AS machineCode,
       temperature_f AS temperatureF, temperature_c AS temperatureC, phase,
       countIf(source_event_id LIKE 'synthetic:%') OVER () AS synthCount,
       count() OVER () AS totalCount
FROM fact_temperature_sample AS s
INNER JOIN dim_machine AS m ON (s.tenant_id = m.tenant_id AND s.machine_id = toString(m.machine_id))
WHERE occurred_at >= {from:String} AND occurred_at < plus(toDate({to:String}), 1)
  AND ({branchId:String} = '' OR s.branch_id = {branchId:String})
  AND ({machineId:String} = '' OR s.machine_id = {machineId:String})
ORDER BY occurred_at ASC LIMIT 5000
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** implement both modules mirroring Task 5's structure (own fixed SQL, gate reuse, numeric coercion `Number()` for aggregates, `temperatureF`/`temperatureC` kept as numbers or null). Register in `registerAnalyticsRoutes` + `registerPath` entries. **Step 4:** run → PASS. **Step 5: Commit**

```bash
git add apps/api/src/analytics/utilization.ts apps/api/src/analytics/utilization.test.ts apps/api/src/analytics/temperature.ts apps/api/src/analytics/temperature.test.ts apps/api/src/analytics/routes.ts apps/api/src/analytics/openapi.ts
git commit -m "feat(api): add utilization heatmap and temperature curve endpoints"
```

---

### Task 7: Branch location store + CRUD

**Files:**
- Modify: `apps/api/src/schema.ts` (new table), `apps/api/src/db.ts` (DDL in `initializeDatabase`)
- Create: `apps/api/src/analytics/branch-location-store.ts`
- Modify: `apps/api/src/analytics/routes.ts` (route + `AnalyticsDeps.branchLocationStore` injection)
- Test: `apps/api/src/analytics/branch-location.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type BranchLocation = { tenantId: string; branchId: string; latitude: number; longitude: number; updatedAt: string };
  export type BranchLocationStore = {
    upsert(input: { tenantId: string; branchId: string; latitude: number; longitude: number }): BranchLocation;
    find(branchId: string): BranchLocation | undefined;
  };
  export function createSqliteBranchLocationStore(database: typeof sqlite): BranchLocationStore;
  ```
  Route: `PUT /api/v1/analytics/branch-location` body `{ branchId, latitude, longitude }`, owner-only via `mayManageAccess`, validates `-90..90` / `-180..180`. Tenant derived from demo owner's single tenant (existing access-store convention — inspect how grants relate tenants during implementation; if tenant id is implicit, use the constant used elsewhere).

- [ ] **Steps:** schema first —

```ts
// schema.ts addition
export const branchLocation = sqliteTable("branch_location", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  branchId: text("branch_id").notNull().unique(),
  latitude: real("latitude").notNull(),
  longitude: real("longitude").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});
```

```sql
-- db.ts initializeDatabase addition
CREATE TABLE IF NOT EXISTS branch_location (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id TEXT NOT NULL UNIQUE,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Tests cover: upsert idempotency (same branchId updates in place), find miss → undefined, PUT route denies non-owner 403, PUT accepts valid coords, PUT rejects out-of-range with 400 `INVALID_COORDINATES`. Commit:

```bash
git add apps/api/src/schema.ts apps/api/src/db.ts apps/api/src/analytics/branch-location-store.ts apps/api/src/analytics/branch-location.test.ts apps/api/src/analytics/routes.ts
git commit -m "feat(api): add branch location storage and owner CRUD route"
```

---

### Task 8: TMD client + forecast proxy

**Files:**
- Create: `apps/api/src/analytics/tmd.ts`
- Modify: `apps/api/src/analytics/routes.ts`, `apps/api/src/analytics/openapi.ts`, `.env.example`, `deploy/.env.production.example`
- Test: `apps/api/src/analytics/tmd.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class TmdError extends Error { constructor(readonly kind: "unconfigured" | "unauthorized" | "rate_limited" | "provider_failed") }
  export type TmdForecastDay = { date: string; tcMin: number | null; tcMax: number | null; rh: number | null; rain: number | null; cond: number | null };
  export type TmdClient = (input: { lat: number; lon: number; date: string; days: number }) => Promise<TmdForecastDay[]>;
  export function createTmdClient(config?: { token?: string; baseUrl?: string; fetchImpl?: typeof fetch; cacheTtlMs?: number }): TmdClient;
  export function describeCondition(code: number | null): string;
  ```
  `AnalyticsDeps` gains `tmd: TmdClient`.

Request shape (verified against TMD docs):

```text
GET https://data.tmd.go.th/nwpapi/v1/forecast/location/daily/at?lat={lat}&lon={lon}&date={YYYY-MM-DD}&duration={days<=10}&fields=tc_min,tc_max,rh,rain,cond
authorization: Bearer $TMD_API_TOKEN
```

Response mapping: `WeatherForecast.WeatherForecasts[]` entries carry `location.{lat,lon}` and `forecast.{date, data.{tc_min,tc_max,rh,rain,cond}}` — map defensively: every numeric field may be absent → `null`; sort by date ascending; cap `days` at 10. Cache key `lat|lon|date|days`, TTL default 5 min. Status mapping: no token → `unconfigured` (never called); 401 → `unauthorized`; 429 → `rate_limited`; other non-2xx/network → `provider_failed`.

Route: `GET /api/v1/analytics/weather/forecast?branchId&days<=10`
- 403 on out-of-scope branch; 422 `BRANCH_LOCATION_MISSING` when no coords stored; 503 `WEATHER_PROVIDER_UNCONFIGURED` / `WEATHER_PROVIDER_ERROR` mapped from `TmdError.kind`.
- Envelope-style response: `{ meta: { branchId, provider: "tmd-nwp-v1", issuedAt, disclaimer }, data: [{ date, tcMin, tcMax, rh, rain, cond, conditionLabel }] }` where `disclaimer` is the fixed string `"Values are NWP model forecasts from the Thai Meteorological Department, not station observations."`

Tests: token unset → rejects `unconfigured` without fetching; maps sample payload; caches repeat calls (fetchImpl called once); 429 → `rate_limited`; route returns 422 when location missing; happy-path proxy returns labels via `describeCondition` (e.g. cond 5 → contains "Rain").

Commit: `feat(api): add TMD NWP weather client and forecast proxy endpoint`

---

### Task 9: Weather ingest job + correlation endpoint

**Files:**
- Create: `apps/api/scripts/fetch-weather-daily.ts`, `apps/api/src/analytics/weather-table.ts` (DDL string + insert helper), `apps/api/src/analytics/correlation.ts`
- Modify: `apps/api/src/analytics/routes.ts`, `apps/api/src/analytics/openapi.ts`, `docs/superpowers/specs/2026-08-08-clickhouse-analytics-schema.md` (append `fact_weather_daily` DDL from the spec)
- Test: `apps/api/src/analytics/correlation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function ingestWeatherForBranches(executor: ClickHouseExecutor, tmd: TmdClient, locations: BranchLocation[], options?: { today?: string }): Promise<number>;
  export function pearsonCorrelation(pairs: { x: number; y: number }[]): number | null; // null when n<2 or zero variance
  ```
  Correlation SQL joins `fact_weather_daily` with per-day usage aggregate on `(tenant_id, branch_id, date)`; endpoint computes Pearson r server-side between `tc_max` and daily cycles.

Route: `GET /api/v1/analytics/weather-usage/correlation?branchId&from&to` (owner/manager)
- n paired days < 14 → 422 `INSUFFICIENT_PAIRED_DATA`.
- Success: `{ meta: { experimental: true, pairedDays, variableX: "tc_max", variableY: "cycles", limits: ["NWP forecasts, not observations.", "Correlation does not imply causation.", "Pearson r measures linear association only."] , ...commonMeta }, data: { pearsonR, pairedDays } }`.

Ingest script behavior: reads `branch_location` rows from SQLite, calls TMD (`date=today, duration=10`), writes `INSERT INTO fact_weather_daily FORMAT JSONEachRow` with `issued_at` = now, `extracted_at` = now. Idempotent by design (ReplacingMergeTree keyed on forecast_date). Run manually: `pnpm --filter @laundrytwin/api exec tsx scripts/fetch-weather-daily.ts`.

Tests: `pearsonCorrelation` known vectors ([{1,2},{2,4},{3,6}] → ~1, anti-correlated → -1, constant x → null); ingest builds expected inserts (fake executor captures SQL, assert `fact_weather_daily` referenced and rows carry `issued_at`); correlation route 422 path; success path returns pearsonR from fixture pairs.

Commits:
```bash
git add apps/api/src/analytics/weather-table.ts apps/api/scripts/fetch-weather-daily.ts docs/superpowers/specs/2026-08-08-clickhouse-analytics-schema.md
git commit -m "feat(api): add fact_weather_daily storage and TMD ingest job"
git add apps/api/src/analytics/correlation.ts apps/api/src/analytics/correlation.test.ts apps/api/src/analytics/routes.ts apps/api/src/analytics/openapi.ts
git commit -m "feat(api): add experimental weather-usage correlation endpoint"
```

---

### Task 10: Playground guide, RTM update, final verification

**Files:**
- Create: `docs/integration/analytics-playground.md`
- Modify: `docs/04_traceability/RTM_matrix.md` (mark F-08 partial evidence, F-12 design evidence), `.env.example` (final review)
- Test: none new

**Content of the guide** (write fully, no stubs):
1. Start local ClickHouse (docker command), run `pnpm --filter @laundrytwin/api exec tsx scripts/seed-analytics.ts`.
2. `LAUNDRYTWIN_DEMO_MODE=true pnpm --filter @laundrytwin/api dev`.
3. `curl -X POST http://localhost:8787/api/demo/session -c cookies.txt`.
4. Open `http://localhost:8787/docs` (Scalar UI), authorize with the demo session cookie conceptually, execute endpoints; raw curl examples for each of the six endpoints with expected envelope shapes.
5. Table of member-owned modules (spec §6) and which task/file owns each.

**Verification sequence (all must pass):**

```bash
pnpm --filter @laundrytwin/api test
pnpm check && pnpm build
git diff --check
```

Commit:
```bash
git add docs/integration/analytics-playground.md docs/04_traceability/RTM_matrix.md .env.example
git commit -m "docs: add analytics playground guide and RTM evidence notes"
```

---

## Self-review notes

- Spec coverage: spec components 1→Tasks 1,3,5; 2→Tasks 5,6 (+7 scope); 3→Task 3; 4→Task 4; 5→Tasks 7,8,9; 6→task split realized as plan tasks 5–9 (parallelizable after Task 4); error handling matrix covered in Tasks 5–9; testing section covered per-task.
- Deliberate deviation from spec wording: playground uses hand-maintained `openapi.ts` registry + `@scalar/hono-api-reference` instead of `@hono/zod-openapi` — avoids rewriting existing route registration style; purpose (self-serve playground + contract test) preserved. Spec stays authority for behavior; this plan records the lighter mechanism.
- Type consistency: `AnalyticsDeps` grows monotonically (clickhouse → +tmd → +branchLocationStore); `Gate`/`analyticsError` defined once in `routes.ts` (Task 3/5) and reused everywhere; `buildTestApp`/`fakeClickhouse` live in `routes.test.ts` and are imported by sibling test files.
