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
        usageRows: "3",
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

  it("surfaces the usage-row presence signal without overloading the provenance axis", async () => {
    authenticate([{ id: "owner-01", role: "owner", branchId: null }]);
    const { clickhouse } = dashboardExecutor();
    const app = createApp({ analyticsDeps: { clickhouse } });

    const response = await app.request("/api/report/dashboard?from=2026-09-18&to=2026-09-25");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.dashboard.usageRowsInRange).toBe(3);
    // `availability` is "how do I know this?"; presence is "is there anything?".
    expect(body.availability).toBe("usage-derived");
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

  // PRODUCT.md lists executive-summary reporting as a current capability, and
  // the summary builder was unit-tested, but this route had no test at all: no
  // authorization case, no redaction case, and no proof it answers at all in the
  // ClickHouse-only deployment that is the documented production shape.
  describe("executive summary route", () => {
    const IRIS_KEYS = ["IRIS_READ_BASE_URL", "IRIS_LAUNDRYTWIN_READ_API_KEY", "LAUNDRYTWIN_DEMO_MODE"] as const;

    /** The ClickHouse-only production shape: no IRIS, no demo client. */
    function withoutIrisReadSource(): () => void {
      const saved = new Map(IRIS_KEYS.map((key) => [key, process.env[key]]));
      for (const key of IRIS_KEYS) delete process.env[key];
      return () => {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      };
    }

    it.each(["/api/report/summary"])("denies a zero-grant principal at %s before any source is called", async (path) => {
      authenticate([]);
      const clickhouse = vi.fn();
      const app = createApp({ analyticsDeps: { clickhouse: clickhouse as unknown as ClickHouseExecutor } });

      const response = await app.request(path);

      expect(response.status).toBe(403);
      expect(clickhouse).not.toHaveBeenCalled();
    });

    it("rejects a branch outside the principal grant before querying", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "tech-01", role: "technician", branchId: "branch-01" }]);
        const clickhouse = vi.fn();
        const app = createApp({ analyticsDeps: { clickhouse: clickhouse as unknown as ClickHouseExecutor } });

        const response = await app.request("/api/report/summary?branchId=branch-02");

        expect(response.status).toBe(403);
        expect(clickhouse).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it("answers from ClickHouse when no IRIS read source is configured", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "owner-01", role: "owner", branchId: null }]);
        const { clickhouse } = dashboardExecutor();
        const app = createApp({ analyticsDeps: { clickhouse } });

        const response = await app.request("/api/report/summary?from=2026-09-18&to=2026-09-25");

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          source: "clickhouse",
          availability: "usage-derived",
          range: { from: "2026-09-18", to: "2026-09-25" },
          generatedBy: "deterministic-reporting-v1",
          generatedAt: expect.any(String)
        });
      } finally {
        restore();
      }
    });

    it.each([
      { role: "technician" as const, branchId: "branch-01", expectsRevenue: false },
      { role: "manager" as const, branchId: "branch-01", expectsRevenue: true }
    ])("keeps revenue out of the $role summary", async ({ role, branchId, expectsRevenue }) => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: `${role}-01`, role, branchId }]);
        const { clickhouse } = dashboardExecutor();
        const app = createApp({ analyticsDeps: { clickhouse } });

        const response = await app.request("/api/report/summary?from=2026-09-18&to=2026-09-25");
        const body = (await response.json()) as { summary: string };

        expect(response.status).toBe(200);
        expect(body.summary).toContain("1 รอบ");
        // The sentence is the one place a redaction would be invisible: the
        // number is absent rather than blank, so a baht figure here would mean
        // the server leaked a total the grant does not cover.
        expect(body.summary.includes("฿")).toBe(expectsRevenue);
      } finally {
        restore();
      }
    });

    it("reports unavailable live state rather than claiming machines are healthy", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "owner-01", role: "owner", branchId: null }]);
        // The fixture's last activity is ten days before today, so freshness
        // resolves to unavailable. "สถานะสดพร้อมใช้งาน" here would be the
        // fabricated-green failure the freshness states exist to prevent.
        const { clickhouse } = dashboardExecutor();
        const app = createApp({ analyticsDeps: { clickhouse } });

        const response = await app.request("/api/report/summary?from=2026-09-18&to=2026-09-25");
        const body = (await response.json()) as { summary: string };

        expect(body.summary).toContain("ข้อมูลสดไม่พร้อม");
        expect(body.summary).not.toContain("สถานะสดพร้อมใช้งาน");
      } finally {
        restore();
      }
    });

    it("stays on the demo client when demo mode is on and no IRIS env var exists", async () => {
      const previousDemoMode = process.env.LAUNDRYTWIN_DEMO_MODE;
      const previousBase = process.env.IRIS_READ_BASE_URL;
      const previousKey = process.env.IRIS_LAUNDRYTWIN_READ_API_KEY;
      process.env.LAUNDRYTWIN_DEMO_MODE = "true";
      delete process.env.IRIS_READ_BASE_URL;
      delete process.env.IRIS_LAUNDRYTWIN_READ_API_KEY;

      try {
        const session = await createApp().request("/api/demo/session", {
          method: "POST",
          headers: { "x-forwarded-for": "198.51.100.77" }
        });
        const cookie = session.headers.get("set-cookie")?.split(";")[0];
        expect(cookie).toBeTruthy();

        const response = await createApp().request("/api/report/summary", { headers: { Cookie: cookie! } });

        expect(response.status).toBe(200);
        const body = await response.json();
        // Demo totals, not the ClickHouse path. createIrisReadClient serves demo
        // mode with no env var set, so an unset base URL must not divert it.
        expect(body.summary).toContain("55 รอบ");
        expect(body.availability).toBe("available");
        expect(body.source).not.toBe("clickhouse");
      } finally {
        if (previousDemoMode === undefined) delete process.env.LAUNDRYTWIN_DEMO_MODE;
        else process.env.LAUNDRYTWIN_DEMO_MODE = previousDemoMode;
        if (previousBase === undefined) delete process.env.IRIS_READ_BASE_URL;
        else process.env.IRIS_READ_BASE_URL = previousBase;
        if (previousKey === undefined) delete process.env.IRIS_LAUNDRYTWIN_READ_API_KEY;
        else process.env.IRIS_LAUNDRYTWIN_READ_API_KEY = previousKey;
      }
    });
  });

  // The Digital Twin loads its branch list from this route and its machines
  // from the next one. Gating the branch list on the dev bypass alone left the
  // ClickHouse-only production deployment with a 503 here, so the whole page
  // was empty even though the warehouse had every branch in it. These cover the
  // fallback and, more importantly, that it stays branch-scoped.
  describe("branch list route", () => {
    const IRIS_KEYS = ["IRIS_READ_BASE_URL", "IRIS_LAUNDRYTWIN_READ_API_KEY", "LAUNDRYTWIN_DEMO_MODE"] as const;

    function withoutIrisReadSource(): () => void {
      const saved = new Map(IRIS_KEYS.map((key) => [key, process.env[key]]));
      for (const key of IRIS_KEYS) delete process.env[key];
      return () => {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      };
    }

    /** Answers the dim_branch projection with two branches, one per call site. */
    function branchesExecutor(): ClickHouseExecutor {
      return vi.fn(async (_sql: string, params?: Record<string, unknown>) => {
        const branchId = String(params?.branchId ?? "");
        if (branchId && branchId !== "branch-01") return [];
        return [
          {
            branch_id: "branch-01",
            branch_name: "สาขาทดสอบ",
            timezone: "Asia/Bangkok",
            active: "1"
          }
        ];
      }) as unknown as ClickHouseExecutor;
    }

    it("denies a zero-grant principal before any source is called", async () => {
      authenticate([]);
      const clickhouse = vi.fn();
      const app = createApp({ analyticsDeps: { clickhouse: clickhouse as unknown as ClickHouseExecutor } });

      const response = await app.request("/api/report/branches");

      expect(response.status).toBe(403);
      expect(clickhouse).not.toHaveBeenCalled();
    });

    it("answers from ClickHouse when no IRIS read source is configured", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "owner-01", role: "owner", branchId: null }]);
        const app = createApp({ analyticsDeps: { clickhouse: branchesExecutor() } });

        const response = await app.request("/api/report/branches");

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          contractVersion: "clickhouse",
          source: "clickhouse",
          fetchedAt: expect.any(String),
          branches: [{ id: "branch-01", name: "สาขาทดสอบ", timezone: "Asia/Bangkok", status: "active" }]
        });
      } finally {
        restore();
      }
    });

    it("asks the warehouse only for a branch-scoped principal's own branch", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "tech-01", role: "technician", branchId: "branch-01" }]);
        const clickhouse = branchesExecutor();
        const app = createApp({ analyticsDeps: { clickhouse } });

        const response = await app.request("/api/report/branches");

        expect(response.status).toBe(200);
        // The unfiltered query is the one that would leak another branch's name
        // and timezone to a technician who has no grant for it.
        for (const call of (clickhouse as unknown as ReturnType<typeof vi.fn>).mock.calls) {
          expect(call[1]).toMatchObject({ branchId: "branch-01" });
        }
      } finally {
        restore();
      }
    });
  });

  // The second half of the same Digital Twin pair. A branch name rendering with
  // no machines under it is the failure this route had: it also gated only on
  // the dev bypass, so production answered 503 after the branch list succeeded.
  // This route had no test of any kind before this one.
  describe("live snapshot route", () => {
    const IRIS_KEYS = ["IRIS_READ_BASE_URL", "IRIS_LAUNDRYTWIN_READ_API_KEY", "LAUNDRYTWIN_DEMO_MODE"] as const;

    function withoutIrisReadSource(): () => void {
      const saved = new Map(IRIS_KEYS.map((key) => [key, process.env[key]]));
      for (const key of IRIS_KEYS) delete process.env[key];
      return () => {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      };
    }

    /** One branch with one machine whose last activity is recent enough to be fresh. */
    function liveExecutor(options: { lastActiveAt: string | null }): ClickHouseExecutor {
      return vi.fn(async (sql: string, params?: Record<string, unknown>) => {
        const branchId = String(params?.branchId ?? "");
        if (sql.includes("dim_branch") && !sql.includes("fact_machine_usage")) {
          return [{ branch_id: "branch-01", branch_name: "สาขาทดสอบ", timezone: "Asia/Bangkok", active: "1" }];
        }
        return [
          {
            tenant_id: "t-01",
            machine_id: "machine-01",
            branch_id: "branch-01",
            machine_code: "W01",
            machine_kind: "washer",
            branch_name: "สาขาทดสอบ",
            status: "running",
            last_active_at: options.lastActiveAt,
            cycle_count: "3"
          }
        ];
      }) as unknown as ClickHouseExecutor;
    }

    it("denies a zero-grant principal before any source is called", async () => {
      authenticate([]);
      const clickhouse = vi.fn();
      const app = createApp({ analyticsDeps: { clickhouse: clickhouse as unknown as ClickHouseExecutor } });

      const response = await app.request("/api/report/live?branchId=branch-01");

      expect(response.status).toBe(403);
      expect(clickhouse).not.toHaveBeenCalled();
    });

    it("answers from ClickHouse when no IRIS read source is configured", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "owner-01", role: "owner", branchId: null }]);
        const app = createApp({
          analyticsDeps: { clickhouse: liveExecutor({ lastActiveAt: new Date().toISOString() }) }
        });

        const response = await app.request("/api/report/live?branchId=branch-01");

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          live: { source: string; branchId: string; machines: { id: string; freshness: string }[] };
        };
        expect(body.live.source).toBe("clickhouse");
        expect(body.live.branchId).toBe("branch-01");
        expect(body.live.machines).toHaveLength(1);
        expect(body.live.machines[0]?.freshness).toBe("fresh");
      } finally {
        restore();
      }
    });

    it("marks usage-derived state unavailable rather than reporting it as live", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "owner-01", role: "owner", branchId: null }]);
        // No recent usage. The snapshot must say so instead of rendering the
        // machine as healthy -- that is the fabricated-green failure the
        // freshness states exist to prevent.
        const app = createApp({ analyticsDeps: { clickhouse: liveExecutor({ lastActiveAt: null }) } });

        const response = await app.request("/api/report/live?branchId=branch-01");

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          live: { machines: { freshness: string; reason?: string; coverage: { liveState: { available: boolean } } }[] };
        };
        const machine = body.live.machines[0];
        expect(machine?.freshness).toBe("unavailable");
        expect(machine?.reason).toBeTruthy();
        expect(machine?.coverage.liveState.available).toBe(false);
      } finally {
        restore();
      }
    });

    it("refuses a branch outside the principal grant before querying", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "tech-01", role: "technician", branchId: "branch-01" }]);
        const clickhouse = vi.fn();
        const app = createApp({ analyticsDeps: { clickhouse: clickhouse as unknown as ClickHouseExecutor } });

        const response = await app.request("/api/report/live?branchId=branch-02");

        expect(response.status).toBe(403);
        expect(clickhouse).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });
  });

  // The warehouse cannot raise alerts -- there is no alert fact source -- but
  // that is an absent source, not a broken one, and the two must not read the
  // same to the operator. This route had no test.
  describe("alerts route", () => {
    const IRIS_KEYS = ["IRIS_READ_BASE_URL", "IRIS_LAUNDRYTWIN_READ_API_KEY", "LAUNDRYTWIN_DEMO_MODE"] as const;

    function withoutIrisReadSource(): () => void {
      const saved = new Map(IRIS_KEYS.map((key) => [key, process.env[key]]));
      for (const key of IRIS_KEYS) delete process.env[key];
      return () => {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      };
    }

    it("denies a zero-grant principal before any source is called", async () => {
      authenticate([]);
      const clickhouse = vi.fn();
      const app = createApp({ analyticsDeps: { clickhouse: clickhouse as unknown as ClickHouseExecutor } });

      const response = await app.request("/api/report/alerts?from=2026-09-25&to=2026-10-01");

      expect(response.status).toBe(403);
      expect(clickhouse).not.toHaveBeenCalled();
    });

    it("reports the absent alert source instead of failing the request", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "owner-01", role: "owner", branchId: null }]);
        const clickhouse = vi.fn();
        const app = createApp({ analyticsDeps: { clickhouse: clickhouse as unknown as ClickHouseExecutor } });

        const response = await app.request("/api/report/alerts?from=2026-09-25&to=2026-10-01");

        expect(response.status).toBe(200);
        // The distinction this route exists to preserve: a 503 would tell the
        // operator the source is broken, when it is the warehouse that has no
        // alert fact table at all. The reason string has to survive so the UI
        // can say which of the two it is.
        await expect(response.json()).resolves.toMatchObject({
          alerts: {
            contractVersion: "clickhouse-alerts-unavailable",
            source: "clickhouse",
            fetchedAt: expect.any(String),
            alerts: [],
            availability: "unavailable",
            reason: "ClickHouse analytics warehouse has no alert fact source"
          }
        });
      } finally {
        restore();
      }
    });

    it("does not query the warehouse to answer it", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "owner-01", role: "owner", branchId: null }]);
        const clickhouse = vi.fn();
        const app = createApp({ analyticsDeps: { clickhouse: clickhouse as unknown as ClickHouseExecutor } });

        await app.request("/api/report/alerts?from=2026-09-25&to=2026-10-01");

        expect(clickhouse).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });
  });

  // fact_machine_event EXISTS and is empty (measured 2026-10-01), which is a
  // different state from alerts having no table at all. A 200 with an empty
  // array reads as "no events happened in this window"; nothing has ever been
  // ingested, so that claim would be a fabrication. This route had no test.
  describe("events route", () => {
    const IRIS_KEYS = ["IRIS_READ_BASE_URL", "IRIS_LAUNDRYTWIN_READ_API_KEY", "LAUNDRYTWIN_DEMO_MODE"] as const;

    function withoutIrisReadSource(): () => void {
      const saved = new Map(IRIS_KEYS.map((key) => [key, process.env[key]]));
      for (const key of IRIS_KEYS) delete process.env[key];
      return () => {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      };
    }

    type EventRow = {
      event_id: string;
      branch_id: string;
      machine_id: string;
      machine_code: string;
      occurred_at: string;
      kind: string;
      phase: string | null;
    };

    const ROW: EventRow = {
      event_id: "evt-2",
      branch_id: "branch-01",
      machine_id: "machine-01",
      machine_code: "W01",
      occurred_at: "2026-09-30 10:00:00.000",
      kind: "state_change",
      phase: "RUNNING"
    };

    function eventsExecutor(rows: EventRow[]): ClickHouseExecutor {
      return vi.fn(async () => rows) as unknown as ClickHouseExecutor;
    }

    it("denies a zero-grant principal before any source is called", async () => {
      authenticate([]);
      const clickhouse = vi.fn();
      const app = createApp({ analyticsDeps: { clickhouse: clickhouse as unknown as ClickHouseExecutor } });

      const response = await app.request("/api/report/events?from=2026-09-25&to=2026-10-01");

      expect(response.status).toBe(403);
      expect(clickhouse).not.toHaveBeenCalled();
    });

    it("rejects a branch outside the principal grant before querying", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "tech-01", role: "technician", branchId: "branch-01" }]);
        const clickhouse = vi.fn();
        const app = createApp({ analyticsDeps: { clickhouse: clickhouse as unknown as ClickHouseExecutor } });

        const response = await app.request("/api/report/events?from=2026-09-25&to=2026-10-01&branchId=branch-02");

        expect(response.status).toBe(403);
        expect(clickhouse).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it("answers from ClickHouse when no IRIS read source is configured", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "owner-01", role: "owner", branchId: null }]);
        const app = createApp({ analyticsDeps: { clickhouse: eventsExecutor([ROW]) } });

        const response = await app.request("/api/report/events?from=2026-09-25&to=2026-10-01");

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          contractVersion: string;
          source: string;
          availability: string;
          events: { eventId: string; machineCode: string; kind: string; phase: string | null }[];
          nextCursor: string | null;
        };
        expect(body.contractVersion).toBe("clickhouse-events");
        expect(body.source).toBe("clickhouse");
        expect(body.availability).toBe("available");
        expect(body.events).toHaveLength(1);
        expect(body.events[0]).toMatchObject({ eventId: "evt-2", machineCode: "W01", kind: "state_change", phase: "RUNNING" });
        expect(body.nextCursor).toBeNull();
      } finally {
        restore();
      }
    });

    // The fabrication this route exists to prevent.
    it("reports an unwritten table as unavailable, never as a window with no events", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "owner-01", role: "owner", branchId: null }]);
        const app = createApp({ analyticsDeps: { clickhouse: eventsExecutor([]) } });

        const response = await app.request("/api/report/events?from=2026-09-25&to=2026-10-01");

        expect(response.status).toBe(200);
        const body = (await response.json()) as { availability: string; reason: string; events: unknown[] };
        // An empty array alone would tell the reader nothing had happened in the
        // window. Nothing has ever been ingested, which is a different claim.
        expect(body.events).toEqual([]);
        expect(body.availability).toBe("unavailable");
        expect(body.reason).toMatch(/fact_machine_event/);
      } finally {
        restore();
      }
    });

    it("marks the telemetry registers the event table cannot back as unavailable", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "owner-01", role: "owner", branchId: null }]);
        const app = createApp({ analyticsDeps: { clickhouse: eventsExecutor([ROW]) } });

        const response = await app.request("/api/report/events?from=2026-09-25&to=2026-10-01");
        const body = (await response.json()) as {
          events: {
            state: { temperatureC: number | null; remainingSeconds: number | null };
            coverage: Record<string, { available: boolean; reason?: string }>;
          }[];
        };
        const event = body.events[0]!;

        // fact_machine_event stores no temperature, remaining time, door, coinbox,
        // or payment. A null there would be indistinguishable from a real
        // reading of zero.
        expect(event.state.temperatureC).toBeNull();
        expect(event.state.remainingSeconds).toBeNull();
        expect(event.coverage.temperatureC?.available).toBe(false);
        expect(event.coverage.temperatureC?.reason).toBeTruthy();
        expect(event.coverage.remainingSeconds?.available).toBe(false);
      } finally {
        restore();
      }
    });

    it("asks for one row past the page so a next cursor means there is more", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "owner-01", role: "owner", branchId: null }]);
        const clickhouse = eventsExecutor([ROW, { ...ROW, event_id: "evt-3" }]);
        const app = createApp({ analyticsDeps: { clickhouse } });

        const response = await app.request("/api/report/events?from=2026-09-25&to=2026-10-01&limit=1");
        const body = (await response.json()) as { events: unknown[]; nextCursor: string | null };

        // Two rows came back for a limit of one: the extra row is the signal.
        expect(body.events).toHaveLength(1);
        expect(body.nextCursor).toBeTruthy();
        const params = (clickhouse as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
        expect(params.limit).toBe(2);
      } finally {
        restore();
      }
    });

    it("scopes the query to a branch-scoped principal's own branch", async () => {
      const restore = withoutIrisReadSource();
      try {
        authenticate([{ id: "tech-01", role: "technician", branchId: "branch-01" }]);
        const clickhouse = eventsExecutor([ROW]);
        const app = createApp({ analyticsDeps: { clickhouse } });

        await app.request("/api/report/events?from=2026-09-25&to=2026-10-01");

        const params = (clickhouse as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
        expect(params.branchId).toBe("branch-01");
      } finally {
        restore();
      }
    });
  });
});
