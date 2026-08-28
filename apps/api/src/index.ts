import { serve } from "@hono/node-server";
import { Scalar } from "@scalar/hono-api-reference";
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
import { createClickHouseClient } from "./analytics/clickhouse";
import { createMcpServer, type McpTransport } from "./analytics/mcp";
import { buildOpenApiDocument } from "./analytics/openapi";
import { registerAnalyticsRoutes, type AnalyticsDeps } from "./analytics/routes";
import { auth } from "./auth";
import { initializeDatabase } from "./db";
import {
  createIrisReadClient,
  IrisReadResponseError,
  IrisReadUnavailableError
} from "./iris-read-client";
import { isDemoModeEnabled } from "./demo-read-client";
import { createBotHandler } from "./bot";
import { verifyLiffIdToken } from "./liff-auth";
import { buildThaiStakeholderSummary, redactDashboardRevenue } from "./reporting";

type AppVariables = {
  principal: Principal | null;
};

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
  const allowedOrigin = process.env.CORS_ORIGIN ?? "http://localhost:5173";
  const mcpAccessToken = process.env.MCP_ACCESS_TOKEN ?? "";
  const clickhouse = dependencies.analyticsDeps?.clickhouse ?? createClickHouseClient();
  const mcp = dependencies.mcp ?? createMcpServer({
    clickhouse,
    allowRevenue: process.env.MCP_ALLOW_REVENUE !== "false"
  });
  const botHandler = createBotHandler({
    mcpUrl: process.env.BOT_MCP_URL ?? "http://127.0.0.1:8787/mcp",
    mcpToken: mcpAccessToken,
    openRouterKey: process.env.OPENROUTER_API_KEY ?? "",
    model: process.env.BOT_MODEL ?? "openai/gpt-4o-mini",
    lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    clickhouse
  });

  app.use(
    "*",
    cors({
      origin: allowedOrigin,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "OPTIONS"],
      credentials: true
    })
  );

  app.get("/health", (c) =>
    c.json({ ok: true, reportingConfigured: Boolean(process.env.IRIS_READ_BASE_URL), demoMode: isDemoModeEnabled() })
  );

  app.post("/api/demo/session", (c) => {
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
    const body = await readJson(c);
    const idToken = getString(body, "idToken");
    if (!idToken) return apiError(c, 400, "INVALID_LIFF_TOKEN", "A LINE ID token is required");

    try {
      const profile = await liffVerifier({ idToken, channelId: process.env.LINE_LOGIN_CHANNEL_ID });
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
      : resolveLiffPrincipal(getCookie(c, "laundrytwin_liff_session")) ??
        resolveDemoPrincipal(getCookie(c, "laundrytwin_demo_session"));
    c.set("principal", principal);
    await next();
  });

  registerAnalyticsRoutes(app, dependencies.analyticsDeps ?? { clickhouse: createClickHouseClient() });

  app.get("/api/me", (c) => {
    const principal = requirePrincipal(c);
    if (principal instanceof Response) return principal;
    return c.json({ user: principal.user, source: principal.source, grants: principal.grants });
  });

  app.get("/api/report/branches", async (c) => {
    const principal = requirePrincipal(c);
    if (principal instanceof Response) return principal;

    try {
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
    const principal = requirePrincipal(c);
    if (principal instanceof Response) return principal;
    const range = readRange(c);
    if (range instanceof Response) return range;
    const scope = resolveReportScope(c, principal, c.req.query("branchId"));
    if (scope instanceof Response) return scope;

    try {
      const dashboard = await iris.getDashboard({ ...range, branchId: scope });
      return c.json({ dashboard: redactDashboardRevenue(dashboard, mayViewRevenue(principal.grants)) });
    } catch (error) {
      return irisError(c, error);
    }
  });

  app.get("/api/report/live", async (c) => {
    const principal = requirePrincipal(c);
    if (principal instanceof Response) return principal;
    const branchId = requireSingleBranch(c, principal, c.req.query("branchId"));
    if (branchId instanceof Response) return branchId;

    try {
      return c.json({ live: await iris.getLiveSnapshot(branchId) });
    } catch (error) {
      return irisError(c, error);
    }
  });

  app.get("/api/report/alerts", async (c) => {
    const principal = requirePrincipal(c);
    if (principal instanceof Response) return principal;
    const range = readRange(c);
    if (range instanceof Response) return range;
    const scope = resolveReportScope(c, principal, c.req.query("branchId"));
    if (scope instanceof Response) return scope;

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
    const principal = requirePrincipal(c);
    if (principal instanceof Response) return principal;
    const range = readRange(c);
    if (range instanceof Response) return range;
    const scope = resolveReportScope(c, principal, c.req.query("branchId"));
    if (scope instanceof Response) return scope;

    try {
      return c.json({
        events: await iris.getEvents({ ...range, branchId: scope, cursor: c.req.query("cursor"), limit: readLimit(c) })
      });
    } catch (error) {
      return irisError(c, error);
    }
  });

  app.get("/api/report/summary", async (c) => {
    const principal = requirePrincipal(c);
    if (principal instanceof Response) return principal;
    const range = readRange(c);
    if (range instanceof Response) return range;
    const scope = resolveReportScope(c, principal, c.req.query("branchId"));
    if (scope instanceof Response) return scope;

    try {
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

function requirePrincipal(c: Context<{ Variables: AppVariables }>) {
  return c.get("principal") ?? apiError(c, 401, "AUTHENTICATION_REQUIRED", "Sign in with an approved LaundryTwin account");
}

function requireOwner(c: Context<{ Variables: AppVariables }>) {
  const principal = requirePrincipal(c);
  if (principal instanceof Response) return principal;
  return mayManageAccess(principal.grants)
    ? principal
    : apiError(c, 403, "OWNER_ROLE_REQUIRED", "Only an owner can manage access");
}

function resolveReportScope(c: Context, principal: Principal, requestedBranchId: string | undefined) {
  if (requestedBranchId) {
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
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (Boolean(from) !== Boolean(to)) {
    return apiError(c, 400, "INVALID_RANGE", "from and to must be supplied together");
  }
  if (from && to) return { from, to };

  const end = new Date();
  return { from: new Date(end.getTime() - 24 * 60 * 60 * 1000).toISOString(), to: end.toISOString() };
}

function readLimit(c: Context) {
  const raw = c.req.query("limit");
  return raw ? Number(raw) : undefined;
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

function apiError(c: Context, status: 400 | 401 | 403 | 404 | 502 | 503, code: string, message: string) {
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
