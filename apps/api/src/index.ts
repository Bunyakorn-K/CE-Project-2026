import { serve } from "@hono/node-server";
import { Scalar } from "@scalar/hono-api-reference";
import { compress } from "hono/compress";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { canAccessBranch, mayManageAccess, mayViewRevenue, type Role } from "./access-policy";
import {
  acknowledgeAlert,
  approveLiffAccessRequest,
  createDemoSession,
  createLiffSession,
  createAccessGrant,
  ensureDemoOwner,
  findLiffUser,
  findUserByEmail,
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
import { isCalendarDate } from "./calendar-date";
import { registerAnalyticsRoutes, type AnalyticsDeps } from "./analytics/routes";
import { parseAnalyticsRange } from "./analytics/scope";
import { initTelemetry, withAnswerSpan } from "./telemetry";
import { startRetentionLoop } from "./retention";
import { listCases, listRuns, runEval } from "./eval";
import { answerForMessage } from "./bot/conversation";
import {
  addDigestRecipient,
  listDigestRecipients,
  listLineUsers,
  readDigestSettings,
  removeDigestRecipient,
  runDigest,
  saveDigestSettings,
  digestSentToday
} from "./digest";
import { auth, resolveTrustedOrigins } from "./auth";
import { initializeDatabase } from "./db";
import {
  createIrisReadClient,
  IrisReadResponseError,
  IrisReadUnavailableError,
  type IrisDashboard,
  type IrisEvents,
  type IrisLiveMachine,
  type IrisLiveSnapshot
} from "./iris-read-client";
import { isDemoModeEnabled } from "./demo-read-client";
import { spaHandler } from "./spa";
import { createBotHandler } from "./bot";
import { LineAdapter } from "./bot/line-adapter";
import { isAlertSweepTokenValid, performAlertSweep } from "./alert-sweep";
import { lineUserIdForUser, readAlertRows, toPublicAlert } from "./alert-detail";
import { readAlertSettings, saveAlertSettings } from "./alert-settings";
import { linkMenuForUser, richMenuDefinitions, type RichMenuApi, type RichMenuKey } from "./rich-menu";
import { createRichMenuApi, syncAndLinkUsers } from "./rich-menu-service";
import { readMenuIds, readMenuSyncTime } from "./rich-menu-store";
import { budgetState } from "./alert-budget";
import { verifyLiffIdToken, parseChannelIds } from "./liff-auth";
import { buildThaiStakeholderSummary, redactDashboardDataRevenue, redactDashboardRevenue } from "./reporting";
import { registerAiRoutes } from "./ai-routes";
import { McpClient, type McpClientLike } from "./bot/mcp-client";
import {
  encodeEventCursor,
  InvalidCursorError,
  queryBranches,
  queryDashboard,
  queryEvents,
  queryMachineStates,
  usageFreshnessOf,
  usageFreshnessReasonOf,
  type DashboardData,
  type MachineInfo
} from "./report/clickhouse-report";

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
  /** The MCP *client* the bot and the AI console share. Tests pass a fake. */
  mcpClient?: McpClientLike;
};

initializeDatabase();

// Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set; never fatal (see telemetry.ts).
void initTelemetry();
// Transcripts, spans and eval results all grow with every message; the disk does not.
startRetentionLoop();

export function createApp(dependencies: AppDependencies = {}) {
  const app = new Hono<{ Variables: AppVariables }>();
  // The built SPA directory. One image serves the whole product, so the API
  // process also answers the static routes nginx used to — see spa.ts for why
  // the fallback refuses server paths.
  const webRoot = process.env.WEB_ROOT?.trim();
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
  // One MCP client for the bot and the backoffice console: the console is a test
  // of the same path, so it must not have a second connection, a second scope or a
  // second set of tool schemas.
  const mcpClient =
    dependencies.mcpClient ??
    new McpClient(process.env.BOT_MCP_URL ?? "http://127.0.0.1:8787/mcp", mcpAccessToken);
  const botHandler = createBotHandler(
    {
      mcpUrl: process.env.BOT_MCP_URL ?? "http://127.0.0.1:8787/mcp",
      mcpToken: mcpAccessToken,
      lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      clickhouse
    },
    undefined,
    mcpClient
  );

  /**
   * One sweep, two entry points.
   *
   * The body is identical for the owner button and the scheduler on purpose:
   * the requirement is met by whatever the scheduler's log quotes, so a shape
   * that differed by caller would make the evidence record ambiguous. Gas is
   * additive — an unreadable gas source reports `unavailable` with a reason and
   * does not fail the IRIS sweep.
   */
  const sweepResponse = async (c: Context) => {
    const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    try {
      const result = await performAlertSweep({
        fetchAlerts: async (window) => (await iris.getAlerts(window)).alerts,
        adapter: new LineAdapter(lineToken),
        adapterAvailable: Boolean(lineToken),
        gas: { clickhouse }
      });
      // 503 means "nothing was measured", not "the IRIS list was unreadable".
      // When gas evaluated, the response is a real sweep over a named window and
      // says so — `iris.state: unavailable` carries the caveat in the body that a
      // status code cannot. Production currently takes the 200 branch, because it
      // configures no IRIS endpoint and the warehouse does have gas rows.
      if (result.iris.state === "unavailable" && result.gas.state !== "evaluated") {
        return apiError(
          c,
          503,
          "REPORTING_SOURCE_UNAVAILABLE",
          "No alert source is configured: IRIS reporting is unset and the gas source returned nothing"
        );
      }
      return c.json(result);
    } catch (error) {
      return irisError(c, error);
    }
  };

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

      // Point the panel at the menu for this role. Rich menus are not messages,
      // so this costs nothing against the 300-a-month allowance, and doing it on
      // login is what makes a role change take effect without a bulk sync. A
      // failure here must never fail the login: the panel is cosmetic, the
      // session is not.
      const menuApi = richMenuClient();
      const menuIds = readMenuIds();
      if (menuApi && menuIds.owner && menuIds.manager && menuIds.technician && menuIds.default) {
        void linkMenuForUser(
          menuApi,
          profile.userId,
          distinctRoles(principal),
          menuIds as Record<RichMenuKey, string>
        ).catch(() => undefined);
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
  registerAiRoutes(app, { mcp: mcpClient });

  app.get("/api/me", (c) => {
    const principal = requirePrincipal(c);
    if (principal instanceof Response) return principal;
    return c.json({ user: principal.user, source: principal.source, grants: principal.grants });
  });

  app.get("/api/report/branches", async (c) => {
    const principal = requireReportPrincipal(c);
    if (principal instanceof Response) return principal;

    try {
      // Same rule as the summary route: this has to answer from whichever
      // source the rest of the report answers from, or the branch list the
      // Digital Twin renders disagrees with the machines it then loads.
      // Gating on the dev bypass alone left the one ClickHouse-only deployment
      // with a working dashboard and no branches at all.
      if (isDevelopmentAuthBypassEnabled() || (!isDemoModeEnabled() && !isIrisReadConfigured())) {
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
      // Same ClickHouse-first rule as the summary and branch list: the Digital
      // Twin reads branches and live state together, so gating only one of them
      // on the dev bypass rendered a page that could name a branch and then
      // show nothing for it. requireSingleBranch already scoped branchId to the
      // principal's own grant, so this cannot widen the read.
      const live =
        isDevelopmentAuthBypassEnabled() || (!isDemoModeEnabled() && !isIrisReadConfigured())
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

    // Same ClickHouse-first rule as the summary, branch list, and live
    // snapshot. The honest empty answer below was already written for the case
    // where the warehouse has no alert fact source; gating it on the dev bypass
    // meant the ClickHouse-only deployment never reached it and showed a 503
    // instead. Reporting "no alerts, and here is why" is the correct state for
    // a warehouse that genuinely cannot raise alerts -- an HTTP error would
    // read as a broken source rather than an absent one.
    if (isDevelopmentAuthBypassEnabled() || (!isDemoModeEnabled() && !isIrisReadConfigured())) {
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

    // Same ClickHouse-first rule as the summary, branch list, live snapshot, and
    // alerts routes: nothing in this report family should answer 503 in the
    // documented ClickHouse-only production shape.
    if (isDevelopmentAuthBypassEnabled() || (!isDemoModeEnabled() && !isIrisReadConfigured())) {
      try {
        return c.json(
          await clickHouseEventEnvelope(clickhouse, {
            ...range,
            branchId: scope,
            cursor: c.req.query("cursor"),
            limit
          })
        );
      } catch (error) {
        return irisError(c, error);
      }
    }

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
      // The summary has to answer from whichever source the rest of the report
      // answers from, or the executive sentence disagrees with the numbers
      // printed beside it. IRIS is optional, so gating this route on the dev
      // bypass alone left the one ClickHouse-only deployment with a working
      // dashboard and a failing summary. Demo stays on the client path because
      // createIrisReadClient serves it without any IRIS env var.
      if (isDevelopmentAuthBypassEnabled() || (!isDemoModeEnabled() && !isIrisReadConfigured())) {
        const [dashboard, machines] = await Promise.all([
          queryDashboard(clickhouse, range.from, range.to, scope),
          queryClickHouseLiveMachines(clickhouse, scope)
        ]);
        const projectedDashboard = redactDashboardRevenue(
          projectClickHouseDashboard(dashboard, range),
          mayViewRevenue(principal.grants)
        );
        return c.json({
          source: "clickhouse",
          availability: "usage-derived",
          range,
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
        source: projectedDashboard.source,
        availability: "available",
        range,
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

  /**
   * One alert, as it was sent — the page a LINE card links to.
   *
   * Authorisation is deliberately narrow: the caller must have been a recipient
   * of THIS alert, or hold branch access to the branch it names. A signed-in user
   * from another branch cannot read it just because they know the id, and an
   * unknown id is a 404 rather than an empty body, so a mistyped link says so.
   */
  app.get("/api/alerts/:id", (c) => {
    const principal = requirePrincipal(c);
    if (principal instanceof Response) return principal;

    const rows = readAlertRows(c.req.param("id"));
    if (rows.length === 0) {
      return apiError(c, 404, "ALERT_NOT_FOUND", "No alert with that id was ever sent");
    }

    const lineUserId = lineUserIdForUser(principal.user.id);
    const addressedToCaller = lineUserId ? rows.find((row) => row.lineUserId === lineUserId) : undefined;
    const branchVisible = rows.find(
      (row) => row.branchId === null || canAccessBranch(principal.grants, row.branchId)
    );
    const visible = addressedToCaller ?? branchVisible;
    if (!visible) {
      return apiError(c, 403, "ALERT_FORBIDDEN", "This alert was not sent to you and its branch is outside your access");
    }
    return c.json({ alert: toPublicAlert(visible) });
  });

  /**
   * The rich menus this deployment owns, and when they were last synced.
   *
   * Owner-only: a sync replaces the panel for every user, which is a decision
   * about what the whole shop sees.
   */
  app.get("/api/admin/rich-menus", (c) => {
    const principal = requireOwner(c);
    if (principal instanceof Response) return principal;
    const liffId = process.env.LIFF_ID ?? "";
    return c.json({
      liffConfigured: Boolean(liffId),
      lineConfigured: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
      syncedAt: readMenuSyncTime(),
      ids: readMenuIds(),
      menus: liffId
        ? richMenuDefinitions(liffId).map((definition) => ({
            key: definition.key,
            name: definition.name,
            chatBarText: definition.chatBarText,
            labels: definition.labels,
            areas: definition.areas
          }))
        : []
    });
  });

  /**
   * Create the menus, upload the images, set the fallback, and link every known
   * user. LINE cannot edit a menu, so this creates new ones and deletes the old.
   */
  app.post("/api/admin/rich-menus/sync", async (c) => {
    const principal = requireOwner(c);
    if (principal instanceof Response) return principal;
    const api = richMenuClient();
    if (!api) {
      return apiError(c, 503, "LINE_NOT_CONFIGURED", "LINE_CHANNEL_ACCESS_TOKEN is not configured");
    }
    const liffId = process.env.LIFF_ID;
    if (!liffId) {
      return apiError(c, 503, "LIFF_NOT_CONFIGURED", "LIFF_ID is not configured, so the menu buttons would go nowhere");
    }
    try {
      const result = await syncAndLinkUsers(api, { liffId });
      return c.json(result);
    } catch (error) {
      return apiError(
        c,
        502,
        "RICH_MENU_SYNC_FAILED",
        error instanceof Error ? error.message : "rich menu sync failed"
      );
    }
  });

  /**
   * Alert delivery settings — the re-notify floor and the monthly message cap.
   *
   * Owner-only, and returned with the month's usage beside them: a cap is only
   * meaningful next to how much of it is already spent, and the person deciding
   * whether 12 hours is too slow is the same person who can see 17 of 200 used.
   */
  app.get("/api/admin/alert-settings", (c) => {
    const principal = requireOwner(c);
    if (principal instanceof Response) return principal;
    const settings = readAlertSettings();
    return c.json({ settings, usage: budgetState(new Date(), settings.monthlyBudget) });
  });

  app.put("/api/admin/alert-settings", async (c) => {
    const principal = requireOwner(c);
    if (principal instanceof Response) return principal;
    const body = await readJson(c);
    const renotifyHours = getNumber(body, "renotifyHours");
    const monthlyBudget = getNumber(body, "monthlyBudget");
    if (renotifyHours === null && monthlyBudget === null) {
      return apiError(c, 400, "INVALID_INPUT", "Send renotifyHours and/or monthlyBudget as numbers");
    }
    const settings = saveAlertSettings(
      {
        ...(renotifyHours !== null ? { renotifyHours } : {}),
        ...(monthlyBudget !== null ? { monthlyBudget } : {})
      },
      principal.user.id
    );
    return c.json({ settings, usage: budgetState(new Date(), settings.monthlyBudget) });
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
    const scope = await validateGrantScope(c, iris, clickhouse, body);
    if (scope instanceof Response) return scope;

    const approvedUser = approveLiffAccessRequest({ requestId: c.req.param("id"), role: scope.role, branchId: scope.branchId, actorUserId: principal.user.id });
    if (!approvedUser) return apiError(c, 404, "ACCESS_REQUEST_NOT_FOUND", "The access request is no longer pending");
    return c.json({ ok: true, user: approvedUser });
  });

  /**
   * Grant a role to an existing account.
   *
   * Approving a pending request was the only way to create a grant, so an owner
   * or manager who signed in on their own could never be given a narrower
   * scope. This is what lets a franchise scope a manager to one branch, and it
   * is what makes branch scoping verifiable on production at all — no account
   * there holds a single-branch grant.
   */
  app.post("/api/admin/grants", async (c) => {
    const principal = requireOwner(c);
    if (principal instanceof Response) return principal;
    const body = await readJson(c);
    const scope = await validateGrantScope(c, iris, clickhouse, body);
    if (scope instanceof Response) return scope;
    const email = getString(body, "email");
    if (!email) return apiError(c, 400, "INVALID_INPUT", "email is required");

    const result = createAccessGrant({ email, role: scope.role, branchId: scope.branchId, actorUserId: principal.user.id });
    if (!result.ok) {
      // The address is the caller's input, so both of these name what the caller
      // must fix rather than reporting an outage.
      if (result.reason === "user-not-found") {
        return apiError(c, 404, "USER_NOT_FOUND", "No account uses that email address");
      }
      return apiError(c, 409, "DUPLICATE_GRANT", "That account already holds this role for that branch");
    }
    return c.json({ ok: true, grant: result.grant });
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
    return sweepResponse(c);
  });

  /**
   * The scheduler's entry point (R05).
   *
   * Guarded by a machine credential, not by a cookie and not by an owner
   * session: a cron job is not a person. `ALERT_SWEEP_TOKEN` unset means the
   * route answers 401 to everything, which is the safe direction — a
   * deployment that forgot the token must not become an open notification
   * trigger.
   *
   * It shares `performAlertSweep` with the owner button above, so the two
   * cannot drift, and it answers the same body so a summary pasted into an
   * evidence record means the same thing whichever route produced it.
   */
  app.post("/api/internal/alerts/sweep", async (c) => {
    if (!isAlertSweepTokenValid(c.req.header("x-alert-sweep-token"), process.env.ALERT_SWEEP_TOKEN)) {
      return apiError(c, 401, "UNAUTHORIZED", "A valid alert sweep token is required");
    }
    return sweepResponse(c);
  });

  /**
   * The daily digest, as an owner sees it: the switch, the time, and who receives it.
   * Everything is off and empty until someone saves it — a bot that starts messaging
   * on its own is the shop's decision, not a deploy's.
   */
  app.get("/api/admin/digest", (c) => {
    const owner = requireOwner(c);
    if (owner instanceof Response) return owner;
    return c.json({
      settings: readDigestSettings(),
      recipients: listDigestRecipients(),
      candidates: listLineUsers(),
      sentToday: digestSentToday()
    });
  });

  app.put("/api/admin/digest", async (c) => {
    const owner = requireOwner(c);
    if (owner instanceof Response) return owner;
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: boolean;
      sendHour?: number;
      sendMinute?: number;
    };
    const settings = saveDigestSettings(
      {
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        sendHour: typeof body.sendHour === "number" ? body.sendHour : undefined,
        sendMinute: typeof body.sendMinute === "number" ? body.sendMinute : undefined
      },
      owner.user.id
    );
    return c.json({ settings });
  });

  app.post("/api/admin/digest/recipients", async (c) => {
    const owner = requireOwner(c);
    if (owner instanceof Response) return owner;
    const body = (await c.req.json().catch(() => ({}))) as { lineUserId?: string };
    if (!body.lineUserId) return apiError(c, 400, "LINE_USER_REQUIRED", "lineUserId is required");
    const result = addDigestRecipient(body.lineUserId, owner.user.id);
    if (!result.ok) {
      return result.reason === "not-linked"
        ? apiError(c, 404, "NOT_LINKED", "No LINE account is linked to that user")
        : apiError(c, 409, "NO_ACCESS", "That account has no role, so it may not receive revenue");
    }
    return c.json({ recipients: listDigestRecipients() });
  });

  app.delete("/api/admin/digest/recipients/:lineUserId", (c) => {
    const owner = requireOwner(c);
    if (owner instanceof Response) return owner;
    removeDigestRecipient(c.req.param("lineUserId"));
    return c.json({ recipients: listDigestRecipients() });
  });

  /**
   * The clock. A cron job cannot resolve "07:00 Bangkok" the way an owner means it,
   * so the DAG wakes up every five minutes and this route decides whether it is time
   * — which also means changing the hour in the console takes effect immediately,
   * with no workflow edit and no redeploy.
   *
   * `?dryRun=1` builds the message and sends nothing, which is how the digest can be
   * read before anyone's phone buzzes. Idempotent by `digest_sent`.
   */
  app.post("/api/internal/digest/run", async (c) => {
    if (!isAlertSweepTokenValid(c.req.header("x-alert-sweep-token"), process.env.ALERT_SWEEP_TOKEN)) {
      return apiError(c, 401, "UNAUTHORIZED", "A valid alert sweep token is required");
    }
    const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const summary = await runDigest({
      adapter: new LineAdapter(lineToken),
      clickhouse,
      dryRun: c.req.query("dryRun") === "1",
      force: c.req.query("force") === "1"
    });
    return c.json({ digest: summary });
  });

  /**
   * Replay the golden set against the model configured right now.
   *
   * Machine-triggered (a workflow, or an owner's script) because a run costs model
   * calls and should not be a stray browser click. To compare two models: run it,
   * switch the model in `/admin/ai`, run it again, and compare the two runs — the
   * settings stay the single source of truth for what production uses.
   */
  app.post("/api/internal/eval/run", async (c) => {
    if (!isAlertSweepTokenValid(c.req.header("x-alert-sweep-token"), process.env.ALERT_SWEEP_TOKEN)) {
      return apiError(c, 401, "UNAUTHORIZED", "A valid alert sweep token is required");
    }
    const body = (await c.req.json().catch(() => ({}))) as { limit?: number };
    const limit = typeof body.limit === "number" ? Math.min(20, Math.max(1, body.limit)) : 5;

    const summary = await runEval({
      limit,
      answer: async (question) => {
        // The same call the bot makes, with a tenant-wide owner scope: a run must
        // exercise production's path, not a simplified one.
        const answer = await answerForMessage(
          {
            userText: question,
            // A throwaway conversation id: the replay must not read the owner's real
            // memory (which would change the answer) and must not write to it either.
            // Unique per question, so one case cannot prime the next.
            lineUserId: `eval:${randomUUID()}`,
            roleLabel: "owner",
            branchContext: "",
            scope: { branchIds: ["*"], canViewRevenue: true },
            actorUserId: null,
            now: new Date()
          },
          { mcp: mcpClient }
        );
        return {
          text: answer.text,
          inputTokens: answer.inputTokens,
          outputTokens: answer.outputTokens,
          model: answer.model,
          promptVersion: answer.promptVersion
        };
      }
    });
    return c.json({ eval: summary });
  });

  app.get("/api/admin/eval/runs", (c) => {
    const owner = requireOwner(c);
    if (owner instanceof Response) return owner;
    return c.json({ runs: listRuns(10), cases: listCases() });
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

  // Static + SPA fallback, registered LAST so every server route above wins.
  // Absent when WEB_ROOT is unset (tests, the ETL image, a bare API run), which
  // keeps a 404 a 404 rather than a read of a directory that is not there.
  if (webRoot) {
    app.use("*", spaHandler(webRoot));
  }

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
    // The IRIS/demo dashboard contract has no usage-row count, so presence is
    // unknown rather than zero. Reporting 0 would claim the demo window is
    // empty, which is exactly the fabrication this field exists to prevent.
    usageRowsInRange: null,
    // Likewise the demo projection carries no `machine_session_id`, so the
    // attribution gap cannot be measured and must not be reported as zero.
    cycleAttribution: null,
    // The IRIS dashboard contract has no per-day field either, so the trend is
    // unknown rather than empty. An empty array here would render a chart with
    // nothing on it, which reads as "no trading" instead of "this source cannot
    // say" — the same distinction `usageRowsInRange: null` above draws.
    trend: null,
    totals: {
      revenueSatang: response.totals.revenueSatang,
      cycles: response.totals.cycles,
      machines: response.totals.machineCount,
      running: branches.reduce((total, branch) => total + branch.running, 0)
    },
    branches
  };
}

function demoFreshnessFields(lastSeen: string | null): Pick<MachineInfo, "freshness" | "freshnessReason"> {
  // Both halves come from the shared helpers rather than being restated here.
  // This function previously re-derived the reason strings itself, so the demo
  // twin and the ClickHouse twin owned two copies of one contract.
  const freshness = usageFreshnessOf(lastSeen);
  return { freshness, freshnessReason: usageFreshnessReasonOf(freshness) };
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
      // Demo `lastSeen` is either ~25s ago or null (see demo-read-client), so
      // it goes through the same freshness computation as real usage rather
      // than being asserted fresh.
      ...demoFreshnessFields(machine.lastSeen),
      // The demo projection carries no opening hours, so this is always
      // `unknown` — stated rather than defaulted, because a default here would
      // be a second place that decides what an absent schedule means, and the
      // two could disagree.
      branchOpenState: "unknown" as const,
      cycleCount: null,
      // The demo projection has no usage-row field, so it cannot say whether
      // the machine was used — only that it has no countable cycle evidence.
      // `unavailable` would claim "no usage rows", which this source never
      // measured. `unknown` is the honest answer and renders differently.
      cycleCountSource: "unknown" as const
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

/**
 * The events envelope for the ClickHouse-only deployment.
 *
 * Unlike alerts, `fact_machine_event` EXISTS -- the DDL ran and the table is
 * empty. That is a genuinely different state and the contract has to say which
 * one it is, because a reader cannot tell them apart from an empty page alone:
 *
 *   - rows returned  -> availability "available"; a real window of machine events
 *   - no rows, table has never been written -> availability "unavailable"
 *
 * An empty `events` array is NOT reported as "no events occurred in this
 * window". Nothing has ever been ingested, so the honest statement is that the
 * source cannot answer, not that the answer is zero. As of 2026-10-01 the live
 * table holds 0 rows (measured, not assumed), which is why the second case is
 * the one production takes today.
 *
 * Coverage is carried per event rather than being flattened away, so a consumer
 * that eventually does receive events can tell which fields the warehouse can
 * actually back. fact_machine_event stores no temperature, remaining time, door,
 * coinbox, or payment -- those live in registers the ETL does not yet ingest --
 * so every one of them is reported unavailable rather than null-as-zero.
 */
async function clickHouseEventEnvelope(
  ch: ClickHouseExecutor,
  params: { from: string; to: string; branchId?: string; cursor?: string; limit?: number }
): Promise<IrisEvents> {
  const { events, hasMore } = await queryEvents(ch, params);
  const lastRow = lastEventRow(events);

  return {
    contractVersion: "clickhouse-events",
    source: "clickhouse",
    fetchedAt: new Date().toISOString(),
    availability: events.length > 0 ? "available" : "unavailable",
    ...(events.length > 0 ? {} : { reason: "fact_machine_event is present but empty; no machine events have been ingested" }),
    events: events.map((event) => ({
      eventId: event.event_id,
      branchId: event.branch_id,
      machineId: event.machine_id,
      machineCode: event.machine_code,
      occurredAt: event.occurred_at,
      kind: event.kind,
      phase: event.phase ?? null,
      state: {
        phase: event.phase ?? null,
        remainingSeconds: null,
        temperatureC: null,
        doorStatus: null,
        coinbox: null,
        paidSatang: null,
        errorCode: null
      },
      coverage: {
        state: { available: true, sourceField: "state_raw", transform: "phase enum" },
        phase: { available: true, sourceField: "phase" },
        remainingSeconds: { available: false, reason: "fact_machine_event carries no remaining-time register" },
        temperatureC: { available: false, reason: "fact_machine_event carries no temperature register" },
        doorStatus: { available: false, reason: "fact_machine_event carries no door register" },
        coinbox: { available: false, reason: "fact_machine_event carries no coinbox register" },
        paidSatang: { available: false, reason: "fact_machine_event carries no payment register" },
        errorCode: { available: false, reason: "fact_machine_event carries no error register" }
      }
    })),
    nextCursor: hasMore && lastRow ? encodeEventCursor({ occurredAt: lastRow.occurred_at, eventId: lastRow.event_id }) : null
  };
}

/** The final row of the page, for the cursor boundary. */
function lastEventRow(events: { occurred_at: string; event_id: string }[]) {
  return events.at(-1);
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
  // Freshness is computed once, in queryMachineStates, and reused here. It was
  // previously recomputed by a private copy of the same thresholds, which is
  // how the twin and the live snapshot could disagree about the same machine.
  return {
    id: state.machineId,
    code: state.machineCode,
    kind: state.machineKind,
    configuredStatus: "active",
    state: state.status,
    remainingSeconds: null,
    lastSeen: state.lastActiveAt,
    freshness: state.freshness,
    ...(state.freshnessReason ? { reason: state.freshnessReason } : {}),
    branchOpenState: state.branchOpenState,
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

function isRunningDemoMachine(machine: { state: string | null }) {
  return machine.state === "washing" || machine.state === "drying" || machine.state === "running";
}

function demoMachineStatus(state: string | null): MachineInfo["status"] {
  if (state === "washing" || state === "drying" || state === "running") return "running";
  if (state === "paid") return "paid";
  if (state === "finished") return "finished";
  if (state === "cancelled") return "cancelled";
  if (state === "admitted") return "admitted";
  if (state === "pending_payment") return "pending";
  if (state === "offline") return "offline";
  if (state === "ready" || state === "idle") return "idle";
  return "unknown";
}

function isDevelopmentAuthBypassEnabled() {
  return process.env.NODE_ENV === "development" && process.env.LAUNDRYTWIN_DEV_BYPASS === "true";
}

// Both halves, because createIrisReadClient throws when either is missing and
// checking only the base URL would route a request at a client that cannot call.
function isIrisReadConfigured(): boolean {
  return Boolean(process.env.IRIS_READ_BASE_URL && process.env.IRIS_LAUNDRYTWIN_READ_API_KEY);
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

/**
 * The one definition of what a grant may be, shared by every route that writes
 * one. Two copies of this rule would be free to drift, and a grant accepted on
 * one path and rejected on the other is the kind of defect no unit test catches
 * because each path is individually correct.
 *
 * Returns the validated scope, or the error response to send.
 */
async function validateGrantScope(
  c: Context,
  iris: IrisClient,
  clickhouse: ClickHouseExecutor,
  body: Record<string, unknown>
): Promise<{ role: Role; branchId: string | null } | Response> {
  const role = getRole(body, "role");
  const branchId = getNullableString(body, "branchId");
  if (!role) return apiError(c, 400, "INVALID_ROLE", "role must be owner, manager, or technician");
  if ((role === "owner" && branchId !== null) || (role !== "owner" && !branchId)) {
    return apiError(c, 400, "INVALID_BRANCH_SCOPE", "owner is tenant-wide; manager and technician need one branch");
  }

  if (branchId) {
    // The branch is checked against the same source the admin page's own branch
    // picker used. It used to be IRIS unconditionally — so on the ClickHouse-only
    // deployment the picker offered real branches from the warehouse and the
    // approval then failed 503 "analytics warehouse unavailable", which reads as an
    // outage rather than as a validation the caller cannot satisfy.
    const clickhouseFirst = isDevelopmentAuthBypassEnabled() || (!isDemoModeEnabled() && !isIrisReadConfigured());
    try {
      if (clickhouseFirst) {
        const branches = await queryBranches(clickhouse, branchId);
        if (!branches.some((branch) => branch.branchId === branchId)) {
          return apiError(c, 400, "UNKNOWN_BRANCH", "The branch does not exist in the analytics warehouse");
        }
      } else {
        const branches = await iris.getBranches();
        if (!branches.branches.some((branch) => branch.id === branchId)) {
          return apiError(c, 400, "UNKNOWN_BRANCH", "The branch is not available in the configured IRIS tenant");
        }
      }
    } catch (error) {
      return irisError(c, error);
    }
  }
  return { role, branchId };
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

/** A finite number from the body, or null — never NaN, never a string. */
function getNumber(value: Record<string, unknown>, key: string): number | null {
  const candidate = value[key];
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string" && candidate.trim() !== "") {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getNullableString(value: Record<string, unknown>, key: string) {
  if (!(key in value) || value[key] === null) return null;
  return getString(value, key);
}

function getRole(value: Record<string, unknown>, key: string): Role | null {
  const role = getString(value, key);
  return role === "owner" || role === "manager" || role === "technician" ? role : null;
}

/**
 * One LINE client for rich menus, created on first use.
 *
 * The login path links a menu on every sign-in; building a client per request
 * would be a new HTTP agent each time for a call that is free but not instant.
 */
let richMenuApi: RichMenuApi | null = null;
function richMenuClient(): RichMenuApi | null {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return null;
  richMenuApi ??= createRichMenuApi(token);
  return richMenuApi;
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

function apiError(c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function irisError(c: Context, error: unknown) {
  // The caller's own malformed input, checked before any source-failure branch.
  // It is a 400 because no retry fixes it and the warehouse is fine; it was 502
  // here before, which read as an outage to anyone acting on the status code.
  if (error instanceof InvalidCursorError) {
    return apiError(c, 400, "INVALID_CURSOR", "The events cursor is not a cursor this build issued");
  }
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

/**
 * Map a LIFF exchange failure to a status the browser can act on.
 *
 * The distinction that matters is WHO must fix it, and the old mapping threw
 * that away: an unknown error became 502, which reads as a server or gateway
 * fault. The common case by far is a browser holding a stale ID token — LINE
 * answers 400 for those — and no amount of retrying fixes it. Only the user
 * fetching a new token does, so that must not be dressed as an outage.
 *
 *   401  the token is expired, malformed, or signed for another channel:
 *        the caller must obtain a new one. LINE being unreachable (502) and a
 *        missing channel id (503) are the only genuine server-side faults.
 *   429  the caller is being rate limited; the response already carries
 *        Retry-After, which is the only thing that helps.
 */
function liffError(c: Context, error: unknown) {
  if (error instanceof Error && "status" in error && typeof error.status === "number") {
    const status = error.status;
    if (status === 401 || status === 502 || status === 503 || status === 429) {
      return apiError(c, status, "LIFF_VERIFICATION_FAILED", error.message);
    }
  }
  // An unrecognized failure is still not evidence that LINE is down. Say what
  // is actually known — this exchange failed — and let the browser re-login,
  // which is safe to attempt because a fresh token cannot make it worse.
  return apiError(c, 401, "LIFF_TOKEN_REJECTED", "LINE identity could not be verified");
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
