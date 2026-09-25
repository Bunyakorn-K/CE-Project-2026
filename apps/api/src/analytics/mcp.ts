import { createHmac, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { ClickHouseUnavailableError, type ClickHouseExecutor } from "./clickhouse";
import { analyticsEnvelope, type AnalyticsMeta } from "./envelope";
import {
  dataSourceEnvelope,
  queryDailyCycles,
  queryDailyRevenue,
  queryTemperatureCurve,
  queryUtilizationHeatmap,
  queryOffPeakWindows
} from "./queries";
import { queryWeatherUsageCorrelation, WEATHER_CAVEAT } from "./weather";
import { rankOffPeakBuckets } from "./offpeak";
import { parseAnalyticsRange } from "./scope";

export const MCP_SCOPE_HEADER = "x-mcp-scope";

export type McpScope = {
  branchIds: string[];
  canViewRevenue: boolean;
};

export type McpDeps = {
  clickhouse: ClickHouseExecutor;
  mcpSecret: string;
  allowRevenue: boolean;
};

const mcpScopeSchema = z.object({
  branchIds: z.array(z.string()),
  canViewRevenue: z.boolean()
});

export function signMcpScope(secret: string, scope: McpScope): string {
  const payload = Buffer.from(JSON.stringify({ branchIds: [...scope.branchIds].sort(), canViewRevenue: scope.canViewRevenue })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyMcpScope(secret: string, header: string): McpScope | null {
  const separator = header.indexOf(".");
  if (separator <= 0) return null;
  const payload = header.slice(0, separator);
  const signature = header.slice(separator + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) return null;
  try {
    const parsed = mcpScopeSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return { branchIds: parsed.branchIds, canViewRevenue: parsed.canViewRevenue };
  } catch {
    return null;
  }
}

function sameScope(left: McpScope, right: McpScope): boolean {
  return left.canViewRevenue === right.canViewRevenue && left.branchIds.length === right.branchIds.length && left.branchIds.every((branchId) => right.branchIds.includes(branchId));
}

function scopeErrorResult(branchId: string, scope: McpScope, requiresRevenue: boolean): ToolResult | null {
  const tenantWide = scope.branchIds.includes("*");
  if (!tenantWide && !scope.branchIds.includes(branchId)) {
    return errorResult("branch_out_of_scope", "The requested branch is outside the caller's scope");
  }
  if (requiresRevenue && !scope.canViewRevenue) {
    return errorResult("revenue_forbidden", "Revenue data requires an owner or manager scope");
  }
  return null;
}

function defaultServiceScope(allowRevenue: boolean): McpScope {
  return { branchIds: ["*"], canViewRevenue: allowRevenue };
}

function scopeAuthError(status: 401 | 403, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export type McpTransport = {
  handle: (request: Request) => Promise<Response>;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function errorResult(code: string, message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }], isError: true };
}

function analyticsErrorResult(error: unknown): ToolResult {
  if (error instanceof ClickHouseUnavailableError) {
    return errorResult("analytics_source_unavailable", "Analytics warehouse is unavailable");
  }
  throw error;
}

function rangeMeta(from: string, to: string, branchId: string): AnalyticsMeta {
  return { range: { from, to }, branchId: branchId || null, dataSource: "empty" };
}

function registerTools(server: McpServer, deps: McpDeps, scope: McpScope): void {
  server.registerTool(
    "get_revenue_daily",
    {
      title: "Daily revenue and cycles",
      description:
        "Daily gross revenue (satang) and paid-cycle counts per branch over a date range. Requires revenue capability in the server-bound scope.",
      inputSchema: {
        from: z.string().describe("YYYY-MM-DD, inclusive start"),
        to: z.string().describe("YYYY-MM-DD, exclusive end (next day)"),
        branchId: z.string().describe("Branch id, or empty string for tenant-wide (owner scope)")
      }
    },
    async (args) => {
      if (!deps.allowRevenue) return errorResult("revenue_disabled", "Revenue tools are disabled for this service token");
      const scopeError = scopeErrorResult(args.branchId, scope, true);
      if (scopeError) return scopeError;
      const range = parseAnalyticsRange(args.from, args.to, new Date());
      if (!range.ok) return errorResult(range.code, range.message);
      try {
        const result = await queryDailyRevenue(deps.clickhouse, { from: range.value.from, to: range.value.to, branchId: args.branchId });
        return textResult(analyticsEnvelope(dataSourceEnvelope(rangeMeta(range.value.from, range.value.to, args.branchId), result), result.rows));
      } catch (error) {
        return analyticsErrorResult(error);
      }
    }
  );

  server.registerTool(
    "get_cycles_daily",
    {
      title: "Daily cycles",
      description: "Daily paid-cycle counts and average duration minutes per branch over a date range.",
      inputSchema: {
        from: z.string().describe("YYYY-MM-DD, inclusive start"),
        to: z.string().describe("YYYY-MM-DD, exclusive end (next day)"),
        branchId: z.string().describe("Branch id, or empty string for tenant-wide (owner scope)")
      }
    },
    async (args) => {
      const scopeError = scopeErrorResult(args.branchId, scope, false);
      if (scopeError) return scopeError;
      const range = parseAnalyticsRange(args.from, args.to, new Date());
      if (!range.ok) return errorResult(range.code, range.message);
      try {
        const result = await queryDailyCycles(deps.clickhouse, { from: range.value.from, to: range.value.to, branchId: args.branchId });
        return textResult(analyticsEnvelope(dataSourceEnvelope(rangeMeta(range.value.from, range.value.to, args.branchId), result), result.rows));
      } catch (error) {
        return analyticsErrorResult(error);
      }
    }
  );

  server.registerTool(
    "get_utilization_heatmap",
    {
      title: "Utilization heatmap",
      description: "Hourly utilization heatmap: duration minutes and cycle counts per machine-hour bucket over a date range.",
      inputSchema: {
        from: z.string().describe("YYYY-MM-DD, inclusive start"),
        to: z.string().describe("YYYY-MM-DD, exclusive end (next day)"),
        branchId: z.string().describe("Branch id, or empty string for tenant-wide (owner scope)")
      }
    },
    async (args) => {
      const scopeError = scopeErrorResult(args.branchId, scope, false);
      if (scopeError) return scopeError;
      const range = parseAnalyticsRange(args.from, args.to, new Date());
      if (!range.ok) return errorResult(range.code, range.message);
      try {
        const result = await queryUtilizationHeatmap(deps.clickhouse, { from: range.value.from, to: range.value.to, branchId: args.branchId });
        return textResult(analyticsEnvelope(dataSourceEnvelope(rangeMeta(range.value.from, range.value.to, args.branchId), result), result.rows));
      } catch (error) {
        return analyticsErrorResult(error);
      }
    }
  );

  server.registerTool(
    "get_temperature_curve",
    {
      title: "Temperature curve",
      description: "Raw wash-phase temperature samples per machine over a date range, capped at 5000 points.",
      inputSchema: {
        from: z.string().describe("YYYY-MM-DD, inclusive start"),
        to: z.string().describe("YYYY-MM-DD, exclusive end (next day)"),
        branchId: z.string().describe("Branch id, or empty string for tenant-wide (owner scope)"),
        machineId: z.string().optional().describe("Optional machine id filter")
      }
    },
    async (args) => {
      const scopeError = scopeErrorResult(args.branchId, scope, false);
      if (scopeError) return scopeError;
      const range = parseAnalyticsRange(args.from, args.to, new Date());
      if (!range.ok) return errorResult(range.code, range.message);
      try {
        const result = await queryTemperatureCurve(deps.clickhouse, {
          from: range.value.from,
          to: range.value.to,
          branchId: args.branchId,
          machineId: args.machineId ?? ""
        });
        return textResult(analyticsEnvelope(dataSourceEnvelope(rangeMeta(range.value.from, range.value.to, args.branchId), result), result.rows));
      } catch (error) {
        return analyticsErrorResult(error);
      }
    }
  );

  server.registerTool(
    "get_weather_usage_correlation",
    {
      title: "Weather × usage correlation",
      description:
        "Daily weather observations (TMD) alongside cycle counts per branch over a date range. " +
        "Correlation only — never causation, not a forecast (F-12 / R12).",
      inputSchema: {
        from: z.string().describe("YYYY-MM-DD, inclusive start"),
        to: z.string().describe("YYYY-MM-DD, exclusive end (next day)"),
        branchId: z.string().describe("Branch id, or empty string for tenant-wide (owner scope)")
      }
    },
    async (args) => {
      const scopeError = scopeErrorResult(args.branchId, scope, false);
      if (scopeError) return scopeError;
      const range = parseAnalyticsRange(args.from, args.to, new Date());
      if (!range.ok) return errorResult(range.code, range.message);
      try {
        const result = await queryWeatherUsageCorrelation(deps.clickhouse, {
          from: range.value.from,
          to: range.value.to,
          branchId: args.branchId
        });
        const envelope = analyticsEnvelope(
          dataSourceEnvelope(rangeMeta(range.value.from, range.value.to, args.branchId), result),
          result.rows
        );
        return textResult({ ...envelope, caveats: WEATHER_CAVEAT });
      } catch (error) {
        return analyticsErrorResult(error);
      }
    }
  );

  server.registerTool(
    "get_off_peak_windows",
    {
      title: "Off-peak windows",
      description:
        "Rank (hour-of-day, weekday) buckets by lowest paid-cycle usage over a date range. " +
        "Buckets with fewer than minCycles cycles are excluded; the bottom `percentile`% of " +
        "remaining buckets are returned with rank 1 = most off-peak. Descriptive baseline, not a forecast (R09).",
      inputSchema: {
        from: z.string().describe("YYYY-MM-DD, inclusive start"),
        to: z.string().describe("YYYY-MM-DD, exclusive end (next day)"),
        branchId: z.string().describe("Branch id, or empty string for tenant-wide (owner scope)"),
        minCycles: z.number().int().min(1).optional().describe("Minimum paid cycles for a bucket to be ranked (default 10)"),
        percentile: z.number().int().min(1).max(99).optional().describe("Bottom percentage of eligible buckets to return (default 25)")
      }
    },
    async (args) => {
      const scopeError = scopeErrorResult(args.branchId, scope, false);
      if (scopeError) return scopeError;
      const range = parseAnalyticsRange(args.from, args.to, new Date());
      if (!range.ok) return errorResult(range.code, range.message);
      const minCycles = args.minCycles ?? 10;
      const percentile = args.percentile ?? 25;
      try {
        const result = await queryOffPeakWindows(deps.clickhouse, {
          from: range.value.from,
          to: range.value.to,
          branchId: args.branchId
        });
        const ranked = rankOffPeakBuckets(result.rows, { minCycles, percentile });
        const meta = {
          ...dataSourceEnvelope(rangeMeta(range.value.from, range.value.to, args.branchId), result),
          method: ranked.meta.method,
          rules: ranked.meta.rules,
          caveats: ["buckets are Asia/Bangkok local hours (UTC+7, no DST)"]
        };
        return textResult(analyticsEnvelope(meta, ranked.data));
      } catch (error) {
        return analyticsErrorResult(error);
      }
    }
  );
}

type McpSession = {
  transport: WebStandardStreamableHTTPServerTransport;
  scope: McpScope;
};

export function createMcpServer(deps: McpDeps): McpTransport {
  const sessions = new Map<string, McpSession>();
  const serviceScope = defaultServiceScope(deps.allowRevenue);

  function makeTransport(scope: McpScope): WebStandardStreamableHTTPServerTransport {
    const server = new McpServer({ name: "laundrytwin-analytics", version: "0.1.0" });
    registerTools(server, deps, scope);
    let transport: WebStandardStreamableHTTPServerTransport;
    transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, scope });
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      }
    });
    void server.connect(transport);
    return transport;
  }

  async function handle(request: Request): Promise<Response> {
    const method = request.method;
    const sessionId = request.headers.get("mcp-session-id");
    const scopeHeader = request.headers.get(MCP_SCOPE_HEADER);
    const suppliedScope = scopeHeader === null ? null : verifyMcpScope(deps.mcpSecret, scopeHeader);
    if (scopeHeader !== null && suppliedScope === null) {
      return scopeAuthError(401, "INVALID_SCOPE", "A valid MCP scope signature is required");
    }

    if (method === "DELETE") {
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          if (suppliedScope && !sameScope(session.scope, suppliedScope)) {
            return scopeAuthError(403, "SCOPE_MISMATCH", "The signed scope does not match the MCP session");
          }
          await session.transport.close();
          sessions.delete(sessionId);
        }
      }
      return new Response(null, { status: 200 });
    }

    if (method !== "POST" && method !== "GET") {
      return new Response(null, { status: 405, headers: { allow: "GET, POST, DELETE" } });
    }

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return new Response("Session not found", { status: 404 });
      if (suppliedScope && !sameScope(session.scope, suppliedScope)) {
        return scopeAuthError(403, "SCOPE_MISMATCH", "The signed scope does not match the MCP session");
      }
      return session.transport.handleRequest(request);
    }

    return makeTransport(suppliedScope ?? serviceScope).handleRequest(request);
  }

  return { handle };
}
