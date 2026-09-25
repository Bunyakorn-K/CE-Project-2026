import { describe, expect, it, vi } from "vitest";

vi.mock("../auth", () => ({
  auth: {
    api: { getSession: vi.fn().mockResolvedValue(null) },
    handler: vi.fn()
  },
  resolveTrustedOrigins: vi.fn(() => ["http://localhost:5173"])
}));

import { createMcpServer, MCP_SCOPE_HEADER, signMcpScope, type McpTransport } from "./mcp";
import { fakeClickhouse } from "./routes.test";

const syntheticDailyRows = [
  { date: "2026-08-01", branchId: "b1", branchName: "SYNTH-A", revenueSatang: "184000", cycles: "31", synthCount: "31", totalCount: "31", avgDurationMin: "38.2" }
];

const mcpSecret = "mcp-test-secret";
const signedBranchScope = signMcpScope(mcpSecret, { branchIds: ["b1"], canViewRevenue: false });
const signedRevenueScope = signMcpScope(mcpSecret, { branchIds: ["b1"], canViewRevenue: true });

async function roundTrip(transport: McpTransport, sessionId: string | null, body: unknown, scopeHeader?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (scopeHeader) headers[MCP_SCOPE_HEADER] = scopeHeader;
  const response = await transport.handle(
    new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(body) })
  );
  const nextSessionId = response.headers.get("mcp-session-id") ?? sessionId;
  const text = await response.text();
  return { status: response.status, sessionId: nextSessionId, body: text ? JSON.parse(text) : null };
}

async function initSession(transport: McpTransport, scopeHeader?: string): Promise<string> {
  const init = await roundTrip(transport, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0" }
    }
  }, scopeHeader);
  const sessionId = init.sessionId;
  if (!sessionId) throw new Error("initialize did not return an mcp-session-id");
  await roundTrip(transport, sessionId, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, scopeHeader);
  return sessionId;
}

async function callTool(transport: McpTransport, sessionId: string, name: string, args: Record<string, unknown>, scopeHeader?: string) {
  const response = await roundTrip(transport, sessionId, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args }
  }, scopeHeader);
  return { ...response, ...(response.body?.result ?? response.body) };
}

function contentText(result: { content?: Array<{ type: string; text: string }> }) {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

const scopedArgs = { from: "2026-08-01", to: "2026-08-31", branchId: "b1" };

describe("MCP data server", () => {
  it("serves the six allow-listed analytics tools", async () => {
    const transport = createMcpServer({ mcpSecret, clickhouse: fakeClickhouse([]), allowRevenue: true });
    const sessionId = await initSession(transport);
    const response = await roundTrip(transport, sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    const tools = response.body?.result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_cycles_daily",
      "get_off_peak_windows",
      "get_revenue_daily",
      "get_temperature_curve",
      "get_utilization_heatmap",
      "get_weather_usage_correlation"
    ]);
  });

  it("does not expose accessScope in any tool schema", async () => {
    const transport = createMcpServer({ mcpSecret, clickhouse: fakeClickhouse([]), allowRevenue: true });
    const sessionId = await initSession(transport);
    const response = await roundTrip(transport, sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    const tools = response.body?.result?.tools as Array<{ name: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } }>;
    for (const tool of tools) {
      expect(tool.inputSchema?.properties ?? {}).not.toHaveProperty("accessScope");
      expect(tool.inputSchema?.required ?? []).not.toContain("accessScope");
    }
  });

  it("defaults to tenant-wide service scope when signed scope is omitted", async () => {
    const clickhouse = fakeClickhouse([
      { match: /toHour\(addHours\(started_at, 7\)\)/, rows: [{ hourOfDay: "21", dayOfWeek: "6", branchId: "b1", branchName: "B1", cycles: "3", totalDurationMin: "120", synthCount: "0", totalCount: "3" }] }
    ]);
    const transport = createMcpServer({ mcpSecret, clickhouse, allowRevenue: true });
    const sessionId = await initSession(transport);
    const result = await callTool(transport, sessionId, "get_off_peak_windows", {
      from: "2026-08-01",
      to: "2026-08-31",
      branchId: "b1",
      minCycles: 1
    });

    expect(result.isError).toBeUndefined();
    const envelope = JSON.parse(contentText(result));
    expect(envelope.meta.method).toBe("offpeak_percentile");
    expect(envelope.data[0]).toMatchObject({ rank: 1, hourOfDay: 21, cycles: 3 });
  });

  it("calls get_off_peak_windows and returns ranked local-hour buckets", async () => {
    const clickhouse = fakeClickhouse([
      {
        match: /toHour\(addHours\(started_at, 7\)\)/,
        rows: [
          { hourOfDay: "21", dayOfWeek: "6", branchId: "b1", branchName: "B1", cycles: "3", totalDurationMin: "120", synthCount: "0", totalCount: "3" },
          { hourOfDay: "10", dayOfWeek: "2", branchId: "b1", branchName: "B1", cycles: "40", totalDurationMin: "1600", synthCount: "0", totalCount: "40" }
        ]
      }
    ]);
    const transport = createMcpServer({ mcpSecret, clickhouse, allowRevenue: true });
    const sessionId = await initSession(transport);
    const result = await callTool(transport, sessionId, "get_off_peak_windows", {
      ...scopedArgs,
      minCycles: 1,
      percentile: 50
    });

    expect(result.isError).toBeUndefined();
    const envelope = JSON.parse(contentText(result));
    expect(envelope.meta.method).toBe("offpeak_percentile");
    expect(envelope.meta.rules).toEqual({ minCycles: 1, percentile: 50, eligibleBuckets: 2, returnedBuckets: 1 });
    expect(envelope.meta.caveats).toContain("buckets are Asia/Bangkok local hours (UTC+7, no DST)");
    expect(envelope.data[0]).toMatchObject({ rank: 1, dayOfWeek: 6, weekday: "Sat", hourOfDay: 21, cycles: 3 });
  });

  it("rejects an out-of-scope branch for get_off_peak_windows before querying", async () => {
    const clickhouse = fakeClickhouse([{ match: /./, rows: [] }]);
    const transport = createMcpServer({ mcpSecret, clickhouse, allowRevenue: true });
    const sessionId = await initSession(transport, signedBranchScope);
    const result = await callTool(transport, sessionId, "get_off_peak_windows", {
      ...scopedArgs,
      branchId: "b2"
    }, signedBranchScope);

    expect(result.isError).toBe(true);
    expect(JSON.parse(contentText(result))).toEqual({ error: { code: "branch_out_of_scope", message: "The requested branch is outside the caller's scope" } });
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("rejects an invalid percentile for get_off_peak_windows", async () => {
    const transport = createMcpServer({ mcpSecret, clickhouse: fakeClickhouse([]), allowRevenue: true });
    const sessionId = await initSession(transport);
    const result = await callTool(transport, sessionId, "get_off_peak_windows", {
      ...scopedArgs,
      percentile: 0
    });

    // zod schema validation rejects at the SDK layer (message, not a JSON envelope).
    expect(result.isError).toBe(true);
    expect(contentText(result)).toMatch(/MCP error/i);
  });

  it("rejects revenue calls without canViewRevenue in the scope", async () => {
    const transport = createMcpServer({ mcpSecret, clickhouse: fakeClickhouse([]), allowRevenue: true });
    const sessionId = await initSession(transport, signedBranchScope);
    const result = await callTool(transport, sessionId, "get_revenue_daily", {
      ...scopedArgs
    }, signedBranchScope);

    expect(result.isError).toBe(true);
    expect(JSON.parse(contentText(result))).toEqual({ error: { code: "revenue_forbidden", message: "Revenue data requires an owner or manager scope" } });
  });

  it("rejects a branch outside the declared scope before querying", async () => {
    const clickhouse = fakeClickhouse([{ match: /./, rows: [] }]);
    const transport = createMcpServer({ mcpSecret, clickhouse, allowRevenue: true });
    const sessionId = await initSession(transport, signedBranchScope);
    const result = await callTool(transport, sessionId, "get_cycles_daily", {
      ...scopedArgs,
      branchId: "b2"
    }, signedBranchScope);

    expect(result.isError).toBe(true);
    expect(JSON.parse(contentText(result))).toEqual({ error: { code: "branch_out_of_scope", message: "The requested branch is outside the caller's scope" } });
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("accepts a tenant-wide scope with an empty branchId and returns the synthetic envelope", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_machine_usage/, rows: syntheticDailyRows }]);
    const transport = createMcpServer({ mcpSecret, clickhouse, allowRevenue: true });
    const sessionId = await initSession(transport, signMcpScope(mcpSecret, { branchIds: ["*"], canViewRevenue: false }));
    const result = await callTool(transport, sessionId, "get_cycles_daily", {
      ...scopedArgs,
      branchId: ""
    }, signMcpScope(mcpSecret, { branchIds: ["*"], canViewRevenue: false }));

    expect(result.isError).toBeUndefined();
    const envelope = JSON.parse(contentText(result));
    expect(envelope.meta.dataSource).toBe("synthetic");
    expect(envelope.meta.range).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(envelope.data[0]).toEqual({ date: "2026-08-01", branchId: "b1", branchName: "SYNTH-A", cycles: 31, avgDurationMin: 38.2 });
  });

  it("returns revenue data in satang when the scope allows revenue", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_machine_usage/, rows: syntheticDailyRows }]);
    const transport = createMcpServer({ mcpSecret, clickhouse, allowRevenue: true });
    const sessionId = await initSession(transport, signedRevenueScope);
    const result = await callTool(transport, sessionId, "get_revenue_daily", scopedArgs, signedRevenueScope);

    const envelope = JSON.parse(contentText(result));
    expect(envelope.data[0]).toEqual({ date: "2026-08-01", branchId: "b1", branchName: "SYNTH-A", revenueSatang: 184000, cycles: 31 });
  });

  it("disables revenue tools when the service token capability flag is off", async () => {
    const transport = createMcpServer({ mcpSecret, clickhouse: fakeClickhouse([]), allowRevenue: false });
    const sessionId = await initSession(transport);
    const result = await callTool(transport, sessionId, "get_revenue_daily", scopedArgs);

    expect(result.isError).toBe(true);
    expect(JSON.parse(contentText(result))).toEqual({ error: { code: "revenue_disabled", message: "Revenue tools are disabled for this service token" } });
  });

  it("rejects an LLM-supplied accessScope that tries to expand the bound scope", async () => {
    const clickhouse = fakeClickhouse([{ match: /./, rows: [] }]);
    const transport = createMcpServer({ mcpSecret, clickhouse, allowRevenue: true });
    const sessionId = await initSession(transport, signedBranchScope);
    const result = await callTool(transport, sessionId, "get_cycles_daily", {
      ...scopedArgs,
      branchId: "b2",
      accessScope: { branchIds: ["b2"], canViewRevenue: true }
    }, signedBranchScope);

    expect(result.isError).toBe(true);
    expect(JSON.parse(contentText(result))).toEqual({ error: { code: "branch_out_of_scope", message: "The requested branch is outside the caller's scope" } });
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("rejects an invalid signed scope before creating a session or querying", async () => {
    const clickhouse = fakeClickhouse([{ match: /./, rows: [] }]);
    const transport = createMcpServer({ mcpSecret, clickhouse, allowRevenue: true });
    const response = await roundTrip(transport, null, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } }
    }, signMcpScope("wrong-secret", { branchIds: ["b1"], canViewRevenue: false }));

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_SCOPE");
    expect(response.sessionId).toBeNull();
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("uses the stored session scope when a later request omits the signed header", async () => {
    const clickhouse = fakeClickhouse([{ match: /./, rows: [] }]);
    const transport = createMcpServer({ mcpSecret, clickhouse, allowRevenue: true });
    const sessionId = await initSession(transport, signedBranchScope);
    const result = await callTool(transport, sessionId, "get_cycles_daily", {
      ...scopedArgs,
      branchId: "b2"
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(contentText(result))).toEqual({ error: { code: "branch_out_of_scope", message: "The requested branch is outside the caller's scope" } });
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("rejects a valid signed scope that does not match the session", async () => {
    const clickhouse = fakeClickhouse([{ match: /./, rows: [] }]);
    const transport = createMcpServer({ mcpSecret, clickhouse, allowRevenue: true });
    const sessionId = await initSession(transport, signedBranchScope);
    const response = await roundTrip(transport, sessionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_cycles_daily", arguments: scopedArgs }
    }, signedRevenueScope);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("SCOPE_MISMATCH");
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("keeps all six allow-listed tools callable under one bound scope", async () => {
    const transport = createMcpServer({ mcpSecret, clickhouse: fakeClickhouse([{ match: /./, rows: [] }]), allowRevenue: true });
    const sessionId = await initSession(transport, signedRevenueScope);
    const toolNames = [
      "get_revenue_daily",
      "get_cycles_daily",
      "get_utilization_heatmap",
      "get_temperature_curve",
      "get_weather_usage_correlation",
      "get_off_peak_windows"
    ];

    for (const name of toolNames) {
      const result = await callTool(transport, sessionId, name, {
        ...scopedArgs,
        machineId: "m1",
        minCycles: 1,
        percentile: 25
      }, signedRevenueScope);
      expect(result.isError, name).toBeUndefined();
    }
  });

  it("uses a non-revenue default scope when service revenue is disabled", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_machine_usage/, rows: syntheticDailyRows }]);
    const transport = createMcpServer({ mcpSecret, clickhouse, allowRevenue: false });
    const sessionId = await initSession(transport);
    const result = await callTool(transport, sessionId, "get_cycles_daily", scopedArgs);

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(contentText(result)).meta.dataSource).toBe("synthetic");
  });
  it("rejects an invalid date range", async () => {
    const transport = createMcpServer({ mcpSecret, clickhouse: fakeClickhouse([]), allowRevenue: true });
    const sessionId = await initSession(transport);
    const result = await callTool(transport, sessionId, "get_cycles_daily", { ...scopedArgs, from: "not-a-date" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(contentText(result)).error.code).toBe("INVALID_RANGE");
  });
});

describe("MCP endpoint auth", () => {
  it("requires a configured bearer token", async () => {
    delete process.env.MCP_ACCESS_TOKEN;
    const { createApp } = await import("../index");
    const app = createApp();

    const response = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: { code: "UNAUTHORIZED", message: "A valid MCP bearer token is required" } });
  });

  it("rejects a wrong bearer token", async () => {
    process.env.MCP_ACCESS_TOKEN = "expected-token";
    const { createApp } = await import("../index");
    const app = createApp();

    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });

    expect(response.status).toBe(401);
  });

  it("accepts the configured bearer token and starts a session", async () => {
    process.env.MCP_ACCESS_TOKEN = "expected-token";
    const { createApp } = await import("../index");
    const app = createApp();

    const response = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer expected-token", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } }
      })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
  });
});
