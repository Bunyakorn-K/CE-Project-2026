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
  queryUtilizationHeatmap
} from "./queries";
import { parseAnalyticsRange } from "./scope";

// The MCP data server exposes only allow-listed, parameterized analytics queries
// (CE pillar F-11). No dynamic SQL and no arbitrary model-generated queries ever
// reach ClickHouse through this surface. Callers pass an explicit accessScope so
// the server enforces declared branch scope + revenue gating; the trusted caller
// (the LINE bot) derives that scope from server-resolved user grants.

export type McpDeps = {
  clickhouse: ClickHouseExecutor;
  /** Service-level capability: when false, revenue tools are rejected even if a caller declares canViewRevenue. */
  allowRevenue: boolean;
};

export type McpTransport = {
  handle: (request: Request) => Promise<Response>;
};

const accessScopeSchema = z.object({
  branchIds: z.array(z.string()),
  canViewRevenue: z.boolean().optional()
});

type AccessScope = z.infer<typeof accessScopeSchema>;

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

function scopeErrorResult(branchId: string, scope: AccessScope, requiresRevenue: boolean): ToolResult | null {
  const tenantWide = scope.branchIds.includes("*");
  if (!tenantWide && !scope.branchIds.includes(branchId)) {
    return errorResult("branch_out_of_scope", "The requested branch is outside the caller's scope");
  }
  if (requiresRevenue && !scope.canViewRevenue) {
    return errorResult("revenue_forbidden", "Revenue data requires an owner or manager scope");
  }
  return null;
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

export function createMcpServer(deps: McpDeps): McpTransport {
  const server = new McpServer({ name: "laundrytwin-analytics", version: "0.1.0" });

  server.registerTool(
    "get_revenue_daily",
    {
      title: "Daily revenue and cycles",
      description:
        "Daily gross revenue (satang) and paid-cycle counts per branch over a date range. Requires canViewRevenue in accessScope.",
      inputSchema: {
        from: z.string().describe("YYYY-MM-DD, inclusive start"),
        to: z.string().describe("YYYY-MM-DD, exclusive end (next day)"),
        branchId: z.string().describe("Branch id, or empty string for tenant-wide (owner scope)"),
        accessScope: accessScopeSchema
      }
    },
    async (args) => {
      if (!deps.allowRevenue) return errorResult("revenue_disabled", "Revenue tools are disabled for this service token");
      const scope = scopeErrorResult(args.branchId, args.accessScope, true);
      if (scope) return scope;
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
        branchId: z.string().describe("Branch id, or empty string for tenant-wide (owner scope)"),
        accessScope: accessScopeSchema
      }
    },
    async (args) => {
      const scope = scopeErrorResult(args.branchId, args.accessScope, false);
      if (scope) return scope;
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
        branchId: z.string().describe("Branch id, or empty string for tenant-wide (owner scope)"),
        accessScope: accessScopeSchema
      }
    },
    async (args) => {
      const scope = scopeErrorResult(args.branchId, args.accessScope, false);
      if (scope) return scope;
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
        machineId: z.string().optional().describe("Optional machine id filter"),
        accessScope: accessScopeSchema
      }
    },
    async (args) => {
      const scope = scopeErrorResult(args.branchId, args.accessScope, false);
      if (scope) return scope;
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

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => crypto.randomUUID()
  });
  void server.connect(transport);
  return { handle: (request) => transport.handleRequest(request) };
}
