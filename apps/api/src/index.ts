import { serve } from "@hono/node-server";
import { Scalar } from "@scalar/hono-api-reference";
import { compress } from "hono/compress";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { Hono, type Context } from "hono";
import { pathToFileURL } from "node:url";
import { canAccessBranch, mayManageAccess, mayViewRevenue, type Role } from "./access-policy";
import {
  acknowledgeAlert,
  approveLiffAccessRequest,
  createDemoSession,
  createLiffSession,
  ensureDemoOwner,
  findLiffUser,
  getDevelopmentOwnerPrincipal,
  getAcknowledgedAlertIds,
  listActiveAccessGrants,
  listPendingAccessRequests,
  recordPendingLiffAccessRequest,
  resolveBetterAuthPrincipal,
  resolveDemoPrincipal,
  resolveLiffPrincipal,
  resolveUserPrincipal,
  revokeLiffSession,
  revokeAccessGrant,
  type Principal
} from "./access-store";
import { createClickHouseClient, type ClickHouseExecutor } from "./analytics/clickhouse";
import { createMcpServer, type McpTransport } from "./analytics/mcp";
import { buildOpenApiDocument } from "./analytics/openapi";
import { registerAnalyticsRoutes, type AnalyticsDeps } from "./analytics/routes";
import { parseAnalyticsRange } from "./analytics/scope";
import { auth, resolveTrustedOrigins } from "./auth";
import { initializeDatabase } from "./db";
import {
  createIrisReadClient,
  IrisReadResponseError,
  IrisReadUnavailableError,
  type IrisDashboard,
  type IrisLiveMachine,
  type IrisLiveSnapshot
} from "./iris-read-client";
import { isDemoModeEnabled } from "./demo-read-client";
import { createBotHandler } from "./bot";
import { LineAdapter } from "./bot/line-adapter";
import { runAlertSweep } from "./alert-engine";
import { verifyLiffIdToken, parseChannelIds } from "./liff-auth";
import { buildThaiStakeholderSummary, redactDashboardDataRevenue, redactDashboardRevenue } from "./reporting";
import { registerAiRoutes } from "./ai-routes";
import { queryBranches, queryDashboard, queryMachineStates, type DashboardData, type MachineInfo } from "./report/clickhouse-report";

type AppVariables = {
  principal: Principal | null;
};

type CustomRateLimitEntry = { count: number; resetAt: number };
const CUSTOM_RATE_LIMITS = new Map<string, CustomRateLimitEntry>();
const MAX_CUSTOM_RATE_LIMIT_ENTRIES = 10_000;

type IrisClient = ReturnType<typeof createIrisReadClient>;
type LiffVerifier = typeof verifyLiffIdToken;

export type AppDependencies = {
  irisClient?: IrisClient;
  liffVerifier?: LiffVerifier;
  analyticsDeps?: AnalyticsDeps;
  mcp?: McpTransport;
};

initializeDatabase();

export function createApp(dependencies: AppDependencies = {}) {
  const app = new Hono<{ Variables: AppVariables }>();
  const iris = dependencies.irisClient ?? createIrisReadClient();
  const liffVerifier = dependencies.liffVerifier ?? verifyLiffIdToken;
  const trustedOrigins = resolveTrustedOrigins();
  const mcpAccessToken = process.env.MCP_ACCESS_TOKEN ?? "";
  const clickhouse = dependencies.analyticsDeps?.clickhouse ?? createClickHouseClient();
  const mcp = dependencies.mcp ?? createMcpServer({
    clickhouse,
    mcpSecret: mcpAccessToken,
    allowRevenue: process.env.MCP_ALLOW_REVENUE === "true"
  });
  const botHandler = createBotHandler({
    mcpUrl: process.env.BOT_MCP_URL ?? "http://127.0.0.1:8787/mcp",
    mcpToken: mcpAccessToken,
    lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    clickhouse
  });

  // Compress JSON responses (esp. analytics payloads like the temperature curve).
  // Node 24 ships CompressionStream, so no extra dependency is needed.
  app.use("*", compress());

  app.use(
    "*",
    cors({
      origin: trustedOrigins,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
      exposeHeaders: ["Retry-After"],
      credentials: true
    })
  );

  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (isStateChangingRequest(c.req.method) && origin !== undefined && !trustedOrigins.includes(origin)) {
      return apiError(c, 403, "UNTRUSTED_ORIGIN", "Request origin is not trusted");
    }
    await next();
  });

  app.get("/health", (c) =>
    c.json({ ok: true, reportingConfigured: Boolean(process.env.IRIS_READ_BASE_URL), demoMode: isDemoModeEnabled() })
  );

  app.post("/api/demo/session", (c) => {
    const retryAfter = consumeCustomRateLimit(c, "demo-session", 60, 10);
    if (retryAfter !== null) return rateLimitError(c, retryAfter);
    if (!isDemoModeEnabled()) {
      return apiError(c, 404, "DEMO_DISABLED", "Demo mode is disabled");
    }
    const demoUser = ensureDemoOwner();
    const session = createDemoSession(demoUser.id);
    setCookie(c, "laundrytwin_demo_session", session.token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: session.expiresAt
    });
    return c.json({ user: demoUser, roles: ["owner"] });
  });

  app.post("/api/auth/liff/exchange", async (c) => {
    const retryAfter = consumeCustomRateLimit(c, "liff-exchange", 60, 10);
    if (retryAfter !== null) return rateLimitError(c, retryAfter);
    const body = await readJson(c);
    const idToken = getString(body, "idToken");
    if (!idToken) return apiError(c, 400, "INVALID_LIFF_TOKEN", "A LINE ID token is required");

    try {
      const profile = await liffVerifier({
        idToken,
        channelIds: parseChannelIds(process.env.LINE_LOGIN_CHANNEL_IDS) ,
        channelId: process.env.LINE_LOGIN_CHANNEL_ID
      });
      const knownUser = findLiffUser(profile.userId);
      if (!knownUser) {
        recordPendingLiffAccessRequest({ lineUserId: profile.userId, displayName: profile.displayName });
        return apiError(c, 403, "ACCESS_PENDING", "Your LINE account is waiting for an administrator to approve access");
      }

      const principal = resolveUserPrincipal(knownUser, "liff");
      if (principal.grants.length === 0) {
        return apiError(c, 403, "ACCESS_NOT_GRANTED", "Your access has been revoked or has not been granted");
      }

      const session = createLiffSession(knownUser.id);
      setCookie(c, "laundrytwin_liff_session", session.token, {
        httpOnly: true,
        sameSite: "Lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        expires: session.expiresAt
      });
      return c.json({ user: principal.user, roles: distinctRoles(principal) });
    } catch (error) {
      return liffError(c, error);
    }
  });

  app.post("/api/auth/liff/logout", (c) => {
    revokeLiffSession(getCookie(c, "laundrytwin_liff_session"));
    revokeLiffSession(getCookie(c, "laundrytwin_demo_session"));
    setCookie(c, "laundrytwin_liff_session", "", {
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0
    });
    setCookie(c, "laundrytwin_demo_session", "", {
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0
    });
    return c.json({ ok: true });
  });

  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.use("/api/*", async (c, next) => {
    const currentSession = await auth.api.getSession({ headers: c.req.raw.headers });
    const principal = currentSession?.user
      ? resolveBetterAuthPrincipal({
          id: currentSession.user.id,
          name: currentSession.user.name,
          email: currentSession.user.email
        })
      : isDevelopmentAuthBypassEnabled()
        ? getDevelopmentOwnerPrincipal()
        : resolveLiffPrincipal(getCookie(c, "laundrytwin_liff_session")) ??
          (isDemoModeEnabled() ? resolveDemoPrincipal(getCookie(c, "laundrytwin_demo_session")) : null);
    c.set("principal", principal);
    await next();
  });

  registerAnalyticsRoutes(app, dependencies.analyticsDeps ?? { clickhouse: createClickHouseClient() });
  registerAiRoutes(app);

  app.get("/api/me", (c) => {
    const principal = requirePrincipal(c);
    if (principal instanceof Response) return principal;
    return c.json({ user: principal.user, source: principal.source, grants: principal.grants });
  });

  app.get("/api/report/branches", async (c) => {
    const principal = requireReportPrincipal(c);
    if (principal instanceof Response) return principal;

    try {
      if (isDevelopmentAuthBypassEnabled()) {
        const allowedBranchIds = grantedReportBranchIds(principal);
        const branches = allowedBranchIds
          ? (await Promise.all(allowedBranchIds.map((branchId) => queryBranches(clickhouse, branchId)))).flat()
          : await queryBranches(clickhouse);
        return c.json({
          contractVersion: "clickhouse",
          source: "clickhouse",
          fetchedAt: new Date().toISOString(),
          branches: branches.map((branch) => ({
            id: branch.branchId,
            code: branch.branchCode,
            name: branch.branchName,
            timezone: branch.timezone,
            status: branch.active ? "active" : "inactive"
          }))
        });
      }

      const response = await iris.getBranches();
      return c.json({
        ...response,
        branches: response.branches.filter((branch) => canAccessBranch(principal.grants, branch.id))
      });
    } catch (error) {
      return irisError(c, error);
    }
  });

  app.get("/api/report/dashboard", async (c) => {
    const principal = requireReportPrincipal(c);
    if (principal instanceof Response) return principal;
    const range = readRange(c);
    if (range instanceof Response) return range;
    const scope = resolveReportScope(c, principal, c.req.query("branchId"));
    if (scope instanceof Response) return scope;

    try {
      const dashboard = redactDashboardDataRevenue(
        isDemoModeEnabled()
          ? await queryDemoDashboard(iris, range.from, range.to, scope)
          : await queryDashboard(clickhouse, range.from, range.to, scope),
        mayViewRevenue(principal.grants)
      );
      return c.json({
        source: dashboard.source,
        fetchedAt: new Date().toISOString(),
        range,
        availability: dashboard.source === "clickhouse" ? "usage-derived" : "available",
        dashboard
      });
    } catch (error: unknown) {
      return irisError(c, error);
    }
  });

  app.get("/api/twin", async (c) => {
    const principal = requireReportPrincipal(c);
    if (principal instanceof Response) return principal;
    const range = readRange(c);
    if (range instanceof Response) return range;
    const scope = resolveReportScope(c, principal, c.req.query("branchId"));
    if (scope instanceof Response) return scope;

    try {
      const states = isDemoModeEnabled()
        ? await queryDemoMachineStates(iris, scope)
        : await queryMachineStates(clickhouse, range.from, range.to, scope);
      const source = isDemoModeEnabled() ? "demo" : "clickhouse";
      return c.json({
        source,
        fetchedAt: new Date().toISOString(),
        range,
        availability: source === "clickhouse" ? "usage-derived" : "available",
        from: range.from,
        to: range.to,
        machines: states
      });
    } catch (error) {
      return irisError(c, error);
    }
  });

  app.get("/api/report/live", async (c) => {
    const principal = requireReportPrincipal(c);
    if (principal instanceof Response) return principal;
    const branchId = requireSingleBranch(c, principal, c.req.query("branchId"));
    if (branchId instanceof Response) return branchId;

    try {
      const live = isDevelopmentAuthBypassEnabled()
        ? await queryClickHouseLiveSnapshot(clickhouse, branchId)
        : await iris.getLiveSnapshot(branchId);
      return c.json({ live });
    } catch (error) {
      return irisError(c, error);
    }
  });

  app.get("/api/report/alerts", async (c) => {
    const principal = requireReportPrincipal(c);
    if (principal instanceof Response) return principal;
    const range = readRange(c);
    if (range instanceof Response) return range;
    const scope = resolveReportScope(c, principal, c.req.query("branchId"));
    if (scope instanceof Response) return scope;

    if (isDevelopmentAuthBypassEnabled()) {
      return c.json({
        alerts: {
          contractVersion: "clickhouse-alerts-unavailable",
          source: "clickhouse",
          fetchedAt: new Date().toISOString(),
          alerts: [],
          availability: "unavailable",
          reason: "ClickHouse analytics warehouse has no alert fact source"
        }
      });
    }

    try {
      const alerts = await iris.getAlerts({ ...range, branchId: scope });
      const acknowledgedIds = getAcknowledgedAlertIds(alerts.alerts.map((alert) => alert.id));
      return c.json({
        alerts: {
          ...alerts,
          alerts: alerts.alerts.map((alert) => ({ ...alert, acknowledgedLocally: acknowledgedIds.has(alert.id) }))
        }
      });
    } catch (error) {
      return irisError(c, error);
    }
  });

  app.get("/api/report/events", async (c) => {
    const principal = requireReportPrincipal(c);
    if (principal instanceof Response) return principal;
    const range = readRange(c);
    if (range instanceof Response) return range;
    const scope = resolveReportScope(c, principal, c.req.query("branchId"));
    if (scope instanceof Response) return scope;
    const limit = readLimit(c);
    if (limit instanceof Response) return limit;

    try {
      return c.json({
        events: await iris.getEvents({ ...range, branchId: scope, cursor: c.req.query("cursor"), limit })
      });
    } catch (error) {
      return irisError(c, error);
    }
  });

  app.get("/api/report/summary", async (c) => {
    const principal = requireReportPrincipal(c);
    if (principal instanceof Response) return principal;
    const range = readRange(c);
    if (range instanceof Response) return range;
    const scope = resolveReportScope(c, principal, c.req.query("branchId"));
    if (scope instanceof Response) return scope;

    try {
      if (isDevelopmentAuthBypassEnabled()) {
        const [dashboard, machines] = await Promise.all([
          queryDashboard(clickhouse, range.from, range.to, scope),
          queryClickHouseLiveMachines(clickhouse, scope)
        ]);
        const projectedDashboard = redactDashboardRevenue(
          projectClickHouseDashboard(dashboard, range),
          mayViewRevenue(principal.grants)
        );
        return c.json({
          summary: buildThaiStakeholderSummary({
            dashboard: projectedDashboard,
            machines,
            openAlertCount: null
          }),
          generatedBy: "deterministic-reporting-v1",
          generatedAt: new Date().toISOString()
        });
      }

      const [dashboard, alerts, live] = await Promise.all([
        iris.getDashboard({ ...range, branchId: scope }),
        iris.getAlerts({ ...range, branchId: scope }),
        scope ? iris.getLiveSnapshot(scope) : Promise.resolve(null)
      ]);
      const projectedDashboard = redactDashboardRevenue(dashboard, mayViewRevenue(principal.grants));
      return c.json({
        summary: buildThaiStakeholderSummary({
          dashboard: projectedDashboard,
          machines: live?.machines ?? [],
          openAlertCount: alerts.alerts.length
        }),
        generatedBy: "deterministic-reporting-v1",
        generatedAt: new Date().toISOString()
      });
    } catch (error) {
      return irisError(c, error);
    }
  });

  app.post("/api/alerts/:id/acknowledge", async (c) => {
    const principal = requirePrincipal(c);
    if (principal instanceof Response) return principal;
    const body = await readJson(c);
    const branchId = getString(body, "branchId");
    if (!branchId || !canAccessBranch(principal.grants, branchId)) {
      return apiError(c, 403, "BRANCH_FORBIDDEN", "You cannot acknowledge alerts for this branch");
    }
    acknowledgeAlert({ irisAlertId: c.req.param("id"), userId: principal.user.id, note: getString(body, "note") });
    return c.json({ ok: true });
  });

  app.get("/api/admin/access-requests", (c) => {
    const principal = requireOwner(c);
    if (principal instanceof Response) return principal;
    return c.json({ requests: listPendingAccessRequests() });
  });

  app.get("/api/admin/grants", (c) => {
    const principal = requireOwner(c);
    if (principal instanceof Response) return principal;
    return c.json({ grants: listActiveAccessGrants() });
  });

  app.post("/api/admin/access-requests/:id/approve", async (c) => {
    const principal = requireOwner(c);
    if (principal instanceof Response) return principal;
    const body = await readJson(c);
    const role = getRole(body, "role");
    const branchId = getNullableString(body, "branchId");
    if (!role) return apiError(c, 400, "INVALID_ROLE", "role must be owner, manager, or technician");
    if ((role === "owner" && branchId !== null) || (role !== "owner" && !branchId)) {
      return apiError(c, 400, "INVALID_BRANCH_SCOPE", "owner is tenant-wide; manager and technician need one branch");
    }

    if (branchId) {
      try {
        const branches = await iris.getBranches();
        if (!branches.branches.some((branch) => branch.id === branchId)) {
          return apiError(c, 400, "UNKNOWN_BRANCH", "The branch is not available in the configured IRIS tenant");
        }
      } catch (error) {
        return irisError(c, error);
      }
    }

    const approvedUser = approveLiffAccessRequest({ requestId: c.req.param("id"), role, branchId, actorUserId: principal.user.id });
    if (!approvedUser) return apiError(c, 404, "ACCESS_REQUEST_NOT_FOUND", "The access request is no longer pending");
    return c.json({ ok: true, user: approvedUser });
  });

  app.post("/api/admin/grants/:id/revoke", (c) => {
    const principal = requireOwner(c);
    if (principal instanceof Response) return principal;
    const result = revokeAccessGrant(c.req.param("id"), principal.user.id);
    if (result === "not-found") {
      return apiError(c, 404, "GRANT_NOT_FOUND", "The grant is already revoked or does not exist");
    }
    if (result === "last-owner") {
      return apiError(c, 400, "LAST_OWNER", "Assign another owner before revoking the last owner grant");
    }
    return c.json({ ok: true });
  });

  app.post("/api/admin/alerts/notify", async (c) => {
    const principal = requireOwner(c);
    if (principal instanceof Response) return principal;
    const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const now = new Date();
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    try {
      const alerts = await iris.getAlerts({ from: from.toISOString(), to: now.toISOString() });
      const summary = await runAlertSweep(alerts.alerts, {
        adapter: new LineAdapter(lineToken),
        adapterAvailable: Boolean(lineToken)
      });
      return c.json({ scanned: alerts.alerts.length, lineConfigured: Boolean(lineToken), summary });
    } catch (error) {
      return irisError(c, error);
    }
  });

  app.post("/webhooks/line", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("x-line-signature");
    return botHandler.handle(rawBody, signature);
  });

  app.get("/api/openapi.json", (c) => c.json(buildOpenApiDocument()));
  app.get("/docs", Scalar({ url: "/api/openapi.json" }));

  app.all("/mcp", async (c) => {
    if (!mcpAccessToken || c.req.header("authorization") !== `Bearer ${mcpAccessToken}`) {
      return apiError(c, 401, "UNAUTHORIZED", "A valid MCP bearer token is required");
    }
    return mcp.handle(c.req.raw);
  });

  return app;
}

export const app = createApp();

async function queryDemoDashboard(iris: IrisClient, from: string, to: string, branchId?: string): Promise<DashboardData> {
  const response = await iris.getDashboard({ from, to, branchId });
  const branches = await Promise.all(
    response.branches.map(async ({ branch, kpi }) => {
      const live = await iris.getLiveSnapshot(branch.id);
      return {
        branchId: branch.id,
        branchName: branch.name,
        revenueSatang: kpi.revenueSatang,
        cycles: kpi.cycles,
        machines: kpi.machineCount,
        running: live.machines.filter(isRunningDemoMachine).length
      };
    })
  );

  return {
    from,
    to,
    source: "demo",
    totals: {
      revenueSatang: response.totals.revenueSatang,
      cycles: response.totals.cycles,
      machines: response.totals.machineCount,
      running: branches.reduce((total, branch) => total + branch.running, 0)
    },
    branches
  };
}

async function queryDemoMachineStates(iris: IrisClient, branchId?: string): Promise<MachineInfo[]> {
  const response = await iris.getBranches();
  const selectedBranches = branchId ? response.branches.filter((branch) => branch.id === branchId) : response.branches;
  const snapshots = await Promise.all(
    selectedBranches.map(async (branch) => ({ branch, live: await iris.getLiveSnapshot(branch.id) }))
  );

  return snapshots.flatMap(({ branch, live }) =>
    live.machines.map((machine) => ({
      tenantId: "demo",
      machineId: machine.id,
      branchId: branch.id,
      machineCode: machine.code,
      machineKind: machine.kind === "dryer" ? "dryer" : "washer",
      branchName: branch.name,
      status: demoMachineStatus(machine.state),
      lastActiveAt: machine.lastSeen,
      cycleCount: null,
      cycleCountSource: "unavailable" as const
    }))
  );
}

function projectClickHouseDashboard(
  dashboard: DashboardData,
  range: { from: string; to: string }
): IrisDashboard {
  return {
    contractVersion: "clickhouse",
    source: "clickhouse",
    fetchedAt: new Date().toISOString(),
    range,
    branches: [],
    totals: {
      revenueSatang: dashboard.totals.revenueSatang ?? 0,
      cycles: dashboard.totals.cycles,
      machineCount: dashboard.totals.machines
    }
  };
}

async function queryClickHouseLiveMachines(ch: ClickHouseExecutor, branchId?: string) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 7);
  const states = await queryMachineStates(
    ch,
    from.toISOString().slice(0, 10),
    to.toISOString().slice(0, 10),
    branchId
  );
  return states.map(toClickHouseLiveMachine);
}

function toClickHouseLiveMachine(state: MachineInfo): IrisLiveMachine {
  const freshness = usageFreshness(state.lastActiveAt);
  return {
    id: state.machineId,
    code: state.machineCode,
    kind: state.machineKind,
    configuredStatus: "active",
    state: state.status,
    remainingSeconds: null,
    lastSeen: state.lastActiveAt,
    freshness,
    ...(freshness !== "fresh" ? { reason: usageFreshnessReason(freshness) } : {}),
    coverage: {
      liveState: {
        available: false,
        reason: "Digital Twin state is derived from usage data; live telemetry is unavailable"
      }
    }
  };
}

async function queryClickHouseLiveSnapshot(
  ch: ClickHouseExecutor,
  branchId: string
): Promise<IrisLiveSnapshot> {
  const branches = await queryBranches(ch, branchId);
  if (!branches.some((branch) => branch.branchId === branchId)) {
    throw new IrisReadResponseError("Branch is not available in ClickHouse", 404);
  }

  return {
    contractVersion: "clickhouse-usage-derived",
    source: "clickhouse",
    fetchedAt: new Date().toISOString(),
    branchId,
    machines: await queryClickHouseLiveMachines(ch, branchId)
  };
}

function usageFreshness(lastActiveAt: string | null): IrisLiveMachine["freshness"] {
  if (!lastActiveAt) return "unavailable";
  const age = Date.now() - new Date(lastActiveAt).getTime();
  if (!Number.isFinite(age)) return "unavailable";
  if (age <= 5 * 60 * 1000) return "fresh";
  if (age <= 30 * 60 * 1000) return "stale";
  return "unavailable";
}

function usageFreshnessReason(freshness: IrisLiveMachine["freshness"]): string {
  if (freshness === "stale") return "Usage data is older than 30 minutes";
  return "No recent usage evidence is available for this machine";
}

function isRunningDemoMachine(machine: { state: string | null }) {
  return machine.state === "washing" || machine.state === "drying" || machine.state === "running";
}

function demoMachineStatus(state: string | null): MachineInfo["status"] {
  if (state === "washing" || state === "drying" || state === "running") return "running";
  if (state === "paid" || state === "finished") return "paid";
  if (state === "pending_payment") return "pending";
  if (state === "offline") return "offline";
  if (state === "ready" || state === "idle") return "idle";
  return "unknown";
}

function isDevelopmentAuthBypassEnabled() {
  return process.env.NODE_ENV === "development" && process.env.LAUNDRYTWIN_DEV_BYPASS === "true";
}

function requirePrincipal(c: Context<{ Variables: AppVariables }>) {
  const principal = c.get("principal");
  return principal ?? apiError(c, 401, "AUTHENTICATION_REQUIRED", "Sign in with an approved LaundryTwin account");
}

function requireReportPrincipal(c: Context<{ Variables: AppVariables }>) {
  const principal = requirePrincipal(c);
  if (principal instanceof Response) return principal;
  return principal.grants.length > 0
    ? principal
    : apiError(c, 403, "ACCESS_NOT_GRANTED", "Your access has been revoked or has not been granted");
}

function requireOwner(c: Context<{ Variables: AppVariables }>) {
  const principal = requirePrincipal(c);
  if (principal instanceof Response) return principal;
  return mayManageAccess(principal.grants)
    ? principal
    : apiError(c, 403, "OWNER_ROLE_REQUIRED", "Only an owner can manage access");
}

function grantedReportBranchIds(principal: Principal): string[] | undefined {
  if (principal.grants.some((grant) => grant.role === "owner")) return undefined;
  return [...new Set(principal.grants.flatMap((grant) => (grant.branchId ? [grant.branchId] : [])))];
}

function resolveReportScope(c: Context, principal: Principal, requestedBranchId: string | undefined) {
  if (principal.grants.length === 0) {
    return apiError(c, 403, "ACCESS_NOT_GRANTED", "Your access has been revoked or has not been granted");
  }
  if (requestedBranchId !== undefined) {
    return canAccessBranch(principal.grants, requestedBranchId)
      ? requestedBranchId
      : apiError(c, 403, "BRANCH_FORBIDDEN", "You cannot view this branch");
  }
  if (principal.grants.some((grant) => grant.role === "owner")) return undefined;

  const grantedBranches = [...new Set(principal.grants.flatMap((grant) => (grant.branchId ? [grant.branchId] : [])))];
  return grantedBranches.length === 1
    ? grantedBranches[0]
    : apiError(c, 400, "BRANCH_REQUIRED", "Choose a branch before loading this report");
}

function requireSingleBranch(c: Context, principal: Principal, requestedBranchId: string | undefined) {
  const scope = resolveReportScope(c, principal, requestedBranchId);
  return scope instanceof Response
    ? scope
    : scope ?? apiError(c, 400, "BRANCH_REQUIRED", "Choose a branch before loading live machine status");
}

function readRange(c: Context) {
  const range = parseAnalyticsRange(c.req.query("from"), c.req.query("to"), new Date());
  if (!range.ok) return apiError(c, range.status, range.code, range.message);
  if (!isCalendarDate(range.value.from) || !isCalendarDate(range.value.to)) {
    return apiError(c, 400, "INVALID_RANGE", "from and to must be YYYY-MM-DD dates");
  }
  return range.value;
}

function isCalendarDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function readLimit(c: Context) {
  const raw = c.req.query("limit");
  if (raw === undefined) return undefined;
  const limit = Number(raw);
  return Number.isInteger(limit) && limit >= 1 && limit <= 200
    ? limit
    : apiError(c, 400, "INVALID_LIMIT", "limit must be an integer from 1 to 200");
}

async function readJson(c: Context) {
  try {
    const value = await c.req.json<unknown>();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function getString(value: Record<string, unknown>, key: string) {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function getNullableString(value: Record<string, unknown>, key: string) {
  if (!(key in value) || value[key] === null) return null;
  return getString(value, key);
}

function getRole(value: Record<string, unknown>, key: string): Role | null {
  const role = getString(value, key);
  return role === "owner" || role === "manager" || role === "technician" ? role : null;
}

function distinctRoles(principal: Principal) {
  return [...new Set(principal.grants.map((grant) => grant.role))];
}

function isStateChangingRequest(method: string) {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function consumeCustomRateLimit(c: Context, bucket: string, windowSeconds: number, max: number): number | null {
  const now = Date.now();
  for (const [key, entry] of CUSTOM_RATE_LIMITS) {
    if (entry.resetAt <= now) CUSTOM_RATE_LIMITS.delete(key);
  }

  const key = `${bucket}:${clientRateLimitKey(c)}`;
  const current = CUSTOM_RATE_LIMITS.get(key);
  if (current && current.count >= max) {
    return Math.max(1, Math.ceil((current.resetAt - now) / 1000));
  }
  if (current) {
    current.count += 1;
    return null;
  }
  if (CUSTOM_RATE_LIMITS.size >= MAX_CUSTOM_RATE_LIMIT_ENTRIES) {
    const oldestKey = CUSTOM_RATE_LIMITS.keys().next().value;
    if (oldestKey) CUSTOM_RATE_LIMITS.delete(oldestKey);
  }
  CUSTOM_RATE_LIMITS.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
  return null;
}

function clientRateLimitKey(c: Context) {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? c.req.header("x-real-ip")?.trim()
    ?? "unknown";
}

function rateLimitError(c: Context, retryAfter: number) {
  c.header("Retry-After", String(retryAfter));
  return apiError(c, 429, "RATE_LIMITED", "Too many requests; try again later");
}

function apiError(c: Context, status: 400 | 401 | 403 | 404 | 429 | 502 | 503, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function irisError(c: Context, error: unknown) {
  if (error instanceof IrisReadUnavailableError) {
    return apiError(c, 503, "REPORTING_SOURCE_UNAVAILABLE", "IRIS reporting is not configured for LaundryTwin");
  }
  if (error instanceof IrisReadResponseError && error.status === 404) {
    return apiError(c, 404, "BRANCH_NOT_FOUND", "The branch is not available in the configured IRIS tenant");
  }
  if (error instanceof IrisReadResponseError && error.status === 400) {
    return apiError(c, 400, "INVALID_REPORT_QUERY", "The requested reporting range or cursor is invalid");
  }
  return apiError(c, 502, "REPORTING_SOURCE_FAILED", "IRIS reporting could not return a usable response");
}

function liffError(c: Context, error: unknown) {
  if (error instanceof Error && "status" in error && typeof error.status === "number") {
    const status = error.status;
    if (status === 401 || status === 502 || status === 503) {
      return apiError(c, status, "LIFF_VERIFICATION_FAILED", error.message);
    }
  }
  return apiError(c, 502, "LIFF_VERIFICATION_FAILED", "LINE identity could not be verified");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port });
  console.log(`LaundryTwin API listening on http://localhost:${port}`);
}

export type AppType = typeof app;
