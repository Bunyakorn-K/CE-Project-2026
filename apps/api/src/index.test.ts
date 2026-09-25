import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "./access-store";
import { sqlite } from "./db";

const testAuth = vi.hoisted(() => ({ principal: null as Principal | null }));

vi.mock("./auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => (testAuth.principal ? { user: testAuth.principal.user } : null))
    },
    handler: vi.fn()
  },
  resolveServerSecret: vi.fn(() => "test-only-secret"),
  resolveTrustedOrigins: vi.fn(() => process.env.CORS_ORIGIN?.split(",").map((origin) => origin.trim()) ?? ["http://localhost:5173"])
}));

vi.mock("./access-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./access-store")>();
  return {
    ...actual,
    resolveBetterAuthPrincipal: vi.fn(() => testAuth.principal)
  };
});

import type { ClickHouseExecutor } from "./analytics/clickhouse";
import { createApp } from "./index";

describe("LaundryTwin API", () => {
  afterEach(() => {
    testAuth.principal = null;
  });

  function authenticate(grants: Principal["grants"]): Principal {
    testAuth.principal = {
      user: { id: "user-01", name: "Test User", email: "test@example.com" },
      source: "better-auth",
      grants
    };
    return testAuth.principal;
  }

  function dashboardExecutor() {
    const executor = vi.fn().mockResolvedValue([
      {
        tenant_id: "tenant-01",
        branch_id: "branch-01",
        machine_id: "machine-01",
        branch_name: "Branch 01",
        machine_code: "W1",
        machine_kind: "washer",
        status: "paid",
        revenueSatang: "12500",
        cycles: "1",
        started_at: "2026-09-20 08:00:00",
        last_active_at: "2026-09-20 08:00:00"
      }
    ]);
    return { executor, clickhouse: executor as unknown as ClickHouseExecutor };
  }

  it("does not call the IRIS source before a local session is established", async () => {
    const getDashboard = vi.fn();
    const app = createApp({
      irisClient: {
        getBranches: vi.fn(),
        getDashboard,
        getLiveSnapshot: vi.fn(),
        getAlerts: vi.fn(),
        getEvents: vi.fn()
      }
    });

    const response = await app.request("/api/report/dashboard");

    expect(response.status).toBe(401);
    expect(getDashboard).not.toHaveBeenCalled();
  });

  it("does not issue a demo session unless demo mode is enabled", async () => {
    const app = createApp();

    const response = await app.request("/api/demo/session", { method: "POST" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "DEMO_DISABLED", message: "Demo mode is disabled" }
    });
  });

  it("requires an explicit demo session cookie before serving demo data", async () => {
    const previousDemoMode = process.env.LAUNDRYTWIN_DEMO_MODE;
    process.env.LAUNDRYTWIN_DEMO_MODE = "true";

    try {
      const app = createApp();
      const anonymous = await app.request("/api/report/dashboard");
      expect(anonymous.status).toBe(401);

      const session = await app.request("/api/demo/session", {
        method: "POST",
        headers: { "x-forwarded-for": "198.51.100.10" }
      });
      expect(session.status).toBe(200);
      const cookie = session.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();

      const dashboard = await app.request("/api/report/dashboard", { headers: { Cookie: cookie! } });
      const twin = await app.request("/api/twin", { headers: { Cookie: cookie! } });

      expect(dashboard.status).toBe(200);
      const dashboardBody = await dashboard.json();
      expect(dashboardBody).toMatchObject({
        source: "demo",
        fetchedAt: expect.any(String),
        range: { from: expect.any(String), to: expect.any(String) },
        availability: "available",
        dashboard: { source: "demo", totals: { cycles: 55, machines: 5, running: 2 } }
      });
      expect(twin.status).toBe(200);
      const twinBody = await twin.json();
      expect(twinBody).toMatchObject({
        source: "demo",
        fetchedAt: expect.any(String),
        range: { from: expect.any(String), to: expect.any(String) },
        availability: "available",
        machines: expect.any(Array)
      });
      expect(twinBody.machines).toContainEqual(expect.objectContaining({ machineId: "demo-r2-d02", status: "unknown" }));
    } finally {
      if (previousDemoMode === undefined) delete process.env.LAUNDRYTWIN_DEMO_MODE;
      else process.env.LAUNDRYTWIN_DEMO_MODE = previousDemoMode;
    }
  });

  it("allows an explicitly enabled development bypass and ignores demo mode in development", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDemoMode = process.env.LAUNDRYTWIN_DEMO_MODE;
    const previousBypass = process.env.LAUNDRYTWIN_DEV_BYPASS;
    process.env.NODE_ENV = "development";
    process.env.LAUNDRYTWIN_DEMO_MODE = "true";
    process.env.LAUNDRYTWIN_DEV_BYPASS = "true";

    try {
      const app = createApp();
      const me = await app.request("/api/me");
      const demoSession = await app.request("/api/demo/session", { method: "POST" });

      expect(me.status).toBe(200);
      await expect(me.json()).resolves.toMatchObject({
        source: "development",
        user: { name: "Development Owner" }
      });
      expect(demoSession.status).toBe(404);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDemoMode === undefined) delete process.env.LAUNDRYTWIN_DEMO_MODE;
      else process.env.LAUNDRYTWIN_DEMO_MODE = previousDemoMode;
      if (previousBypass === undefined) delete process.env.LAUNDRYTWIN_DEV_BYPASS;
      else process.env.LAUNDRYTWIN_DEV_BYPASS = previousBypass;
    }
  });

  it("rejects development bypass without the explicit flag", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousBypass = process.env.LAUNDRYTWIN_DEV_BYPASS;
    process.env.NODE_ENV = "development";
    delete process.env.LAUNDRYTWIN_DEV_BYPASS;

    try {
      const app = createApp();
      const response = await app.request("/api/me");

      expect(response.status).toBe(401);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousBypass === undefined) delete process.env.LAUNDRYTWIN_DEV_BYPASS;
      else process.env.LAUNDRYTWIN_DEV_BYPASS = previousBypass;
    }
  });

  it("rejects the development bypass in production even when the flag is set", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousBypass = process.env.LAUNDRYTWIN_DEV_BYPASS;
    process.env.NODE_ENV = "production";
    process.env.LAUNDRYTWIN_DEV_BYPASS = "true";

    try {
      const app = createApp();
      const response = await app.request("/api/me");

      expect(response.status).toBe(401);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousBypass === undefined) delete process.env.LAUNDRYTWIN_DEV_BYPASS;
      else process.env.LAUNDRYTWIN_DEV_BYPASS = previousBypass;
    }
  });

  it("uses the global development principal for analytics v1", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousBypass = process.env.LAUNDRYTWIN_DEV_BYPASS;
    process.env.NODE_ENV = "development";
    process.env.LAUNDRYTWIN_DEV_BYPASS = "true";
    const clickhouse = vi.fn().mockResolvedValue([
      {
        date: "2026-09-25",
        branchId: "branch-01",
        branchName: "Branch 01",
        revenueSatang: "1000",
        cycles: "1",
        avgDurationMin: "30",
        synthCount: "0",
        totalCount: "1"
      }
    ]);

    try {
      const app = createApp({ analyticsDeps: { clickhouse: clickhouse as unknown as ClickHouseExecutor } });
      const response = await app.request("/api/v1/analytics/cycles/daily?from=2026-09-25&to=2026-09-25");

      expect(response.status).toBe(200);
      expect(clickhouse).toHaveBeenCalled();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousBypass === undefined) delete process.env.LAUNDRYTWIN_DEV_BYPASS;
      else process.env.LAUNDRYTWIN_DEV_BYPASS = previousBypass;
    }
  });

  it("does not persist a development bypass owner", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousBypass = process.env.LAUNDRYTWIN_DEV_BYPASS;
    process.env.NODE_ENV = "development";
    process.env.LAUNDRYTWIN_DEV_BYPASS = "true";
    sqlite.prepare("DELETE FROM access_grant WHERE user_id IN (SELECT id FROM user WHERE email = ?)").run("development.owner@laundrytwin.local");
    sqlite.prepare("DELETE FROM user WHERE email = ?").run("development.owner@laundrytwin.local");

    try {
      const app = createApp();
      const response = await app.request("/api/me");
      const row = sqlite.prepare("SELECT COUNT(*) AS count FROM user WHERE email = ?").get("development.owner@laundrytwin.local") as { count: number };

      expect(response.status).toBe(200);
      expect(row.count).toBe(0);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousBypass === undefined) delete process.env.LAUNDRYTWIN_DEV_BYPASS;
      else process.env.LAUNDRYTWIN_DEV_BYPASS = previousBypass;
    }
  });

  it("uses ClickHouse branch metadata in development", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousBypass = process.env.LAUNDRYTWIN_DEV_BYPASS;
    process.env.NODE_ENV = "development";
    process.env.LAUNDRYTWIN_DEV_BYPASS = "true";

    try {
      const clickhouse = vi.fn().mockResolvedValue([
        {
          branch_id: "branch-01",
          branch_name: "Branch 01",
          branch_code: "01",
          timezone: "Asia/Bangkok",
          active: "1"
        }
      ]) as unknown as ClickHouseExecutor;
      const app = createApp({ analyticsDeps: { clickhouse } });
      const response = await app.request("/api/report/branches");

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        source: "clickhouse",
        branches: [{ id: "branch-01", name: "Branch 01", timezone: "Asia/Bangkok" }]
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousBypass === undefined) delete process.env.LAUNDRYTWIN_DEV_BYPASS;
      else process.env.LAUNDRYTWIN_DEV_BYPASS = previousBypass;
    }
  });

  it("rejects malformed, inverted, and overlong ranges before any ClickHouse call", async () => {
    authenticate([{ id: "owner-01", role: "owner", branchId: null }]);
    const clickhouse = vi.fn();
    const app = createApp({ analyticsDeps: { clickhouse: clickhouse as unknown as ClickHouseExecutor } });
    const invalidQueries = [
      "from=2026-02-30&to=2026-03-01",
      "from=2026-03-02&to=2026-03-01",
      "from=2026-01-01&to=2026-04-02"
    ];

    for (const path of ["/api/report/dashboard", "/api/twin"]) {
      for (const query of invalidQueries) {
        const response = await app.request(`${path}?${query}`);
        expect(response.status).toBe(400);
      }
    }

    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("denies zero-grant principals before report sources are called", async () => {
    authenticate([]);
    const clickhouse = vi.fn();
    const app = createApp({ analyticsDeps: { clickhouse: clickhouse as unknown as ClickHouseExecutor } });

    for (const path of ["/api/report/branches", "/api/report/dashboard", "/api/twin"]) {
      const response = await app.request(path);
      expect(response.status).toBe(403);
    }

    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("denies zero-grant principals in analytics v1", async () => {
    authenticate([]);
    const clickhouse = vi.fn();
    const app = createApp({ analyticsDeps: { clickhouse: clickhouse as unknown as ClickHouseExecutor } });

    const response = await app.request("/api/v1/analytics/cycles/daily");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "ACCESS_NOT_GRANTED", message: "Your access has been revoked or has not been granted" }
    });
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("rejects a branch outside the principal grant before querying", async () => {
    authenticate([{ id: "tech-01", role: "technician", branchId: "branch-01" }]);
    const clickhouse = vi.fn();
    const app = createApp({ analyticsDeps: { clickhouse: clickhouse as unknown as ClickHouseExecutor } });

    const response = await app.request("/api/report/dashboard?branchId=branch-02");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "BRANCH_FORBIDDEN", message: "You cannot view this branch" }
    });
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it.each(["0", "201", "1.5", "not-a-number"])("rejects invalid event limit %s before source access", async (limit) => {
    authenticate([{ id: "tech-01", role: "technician", branchId: "branch-01" }]);
    const getEvents = vi.fn();
    const app = createApp({
      irisClient: {
        getBranches: vi.fn(),
        getDashboard: vi.fn(),
        getLiveSnapshot: vi.fn(),
        getAlerts: vi.fn(),
        getEvents
      }
    });

    const response = await app.request(`/api/report/events?limit=${limit}`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_LIMIT", message: "limit must be an integer from 1 to 200" }
    });
    expect(getEvents).not.toHaveBeenCalled();
  });

  it("enforces trusted origins for state-changing API requests", async () => {
    const previousCorsOrigin = process.env.CORS_ORIGIN;
    process.env.CORS_ORIGIN = "http://localhost:5173, https://app.example.com";

    try {
      const app = createApp();
      const rejected = await app.request("/api/auth/liff/exchange", {
        method: "POST",
        headers: { Origin: "https://evil.example.com" }
      });
      const accepted = await app.request("/api/auth/liff/exchange", {
        method: "POST",
        headers: { Origin: "https://app.example.com", "x-forwarded-for": "198.51.100.30" }
      });
      const serverRequest = await app.request("/api/auth/liff/exchange", {
        method: "POST",
        headers: { "x-forwarded-for": "198.51.100.31" }
      });
      const preflight = await app.request("/api/ai/settings", {
        method: "OPTIONS",
        headers: { Origin: "https://app.example.com", "Access-Control-Request-Method": "PUT" }
      });

      expect(rejected.status).toBe(403);
      await expect(rejected.json()).resolves.toEqual({
        error: { code: "UNTRUSTED_ORIGIN", message: "Request origin is not trusted" }
      });
      expect(accepted.status).toBe(400);
      expect(accepted.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
      expect(serverRequest.status).toBe(400);
      expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT");
    } finally {
      if (previousCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = previousCorsOrigin;
    }
  });

  it("rate limits the custom LINE exchange endpoint", async () => {
    const app = createApp();
    const headers = { "x-forwarded-for": "198.51.100.40" };

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.request("/api/auth/liff/exchange", { method: "POST", headers });
      expect(response.status).toBe(400);
    }

    const limited = await app.request("/api/auth/liff/exchange", { method: "POST", headers });

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    await expect(limited.json()).resolves.toEqual({
      error: { code: "RATE_LIMITED", message: "Too many requests; try again later" }
    });
  });

  it.each([
    { role: "technician" as const, branchId: "branch-01", expectedRevenue: null, expectedScope: "branch-01" },
    { role: "manager" as const, branchId: "branch-01", expectedRevenue: 12500, expectedScope: "branch-01" },
    { role: "owner" as const, branchId: null, expectedRevenue: 12500, expectedScope: "" }
  ])("applies revenue visibility and branch scope for $role", async ({ role, branchId, expectedRevenue, expectedScope }) => {
    authenticate([{ id: `${role}-01`, role, branchId }]);
    const { executor, clickhouse } = dashboardExecutor();
    const app = createApp({ analyticsDeps: { clickhouse } });

    const response = await app.request("/api/report/dashboard?from=2026-09-18&to=2026-09-25");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      source: "clickhouse",
      fetchedAt: expect.any(String),
      range: { from: "2026-09-18", to: "2026-09-25" },
      availability: "usage-derived"
    });
    expect(body.dashboard.totals.revenueSatang).toBe(expectedRevenue);
    expect(body.dashboard.branches[0].revenueSatang).toBe(expectedRevenue);
    expect(executor).toHaveBeenCalledWith(
      expect.stringContaining("toString(u.branch_id) = {branchId:String}"),
      { from: "2026-09-18", to: "2026-09-25", branchId: expectedScope }
    );
  });
});
