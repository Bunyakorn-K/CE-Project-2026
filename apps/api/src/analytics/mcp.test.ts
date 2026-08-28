import { describe, expect, it, vi } from "vitest";

vi.mock("../auth", () => ({
  auth: {
    api: { getSession: vi.fn().mockResolvedValue(null) },
    handler: vi.fn()
  }
}));

import type { McpTransport } from "./mcp";
import { createMcpServer } from "./mcp";
import type { ClickHouseExecutor } from "./clickhouse";
import { fakeClickhouse } from "./routes.test";

const syntheticDailyRows = [
  { date: "2026-08-01", branchId: "b1", branchName: "SYNTH-A", revenueSatang: "184000", cycles: "31", synthCount: "31", totalCount: "31", avgDurationMin: "38.2" }
];

async function roundTrip(transport: McpTransport, sessionId: string | null, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await transport.handle(
    new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(body) })
  );
  const nextSessionId = response.headers.get("mcp-session-id") ?? sessionId;
  const text = await response.text();
  return { status: response.status, sessionId: nextSessionId, body: text ? JSON.parse(text) : null };
}

async function initSession(transport: McpTransport): Promise<string> {
  const init = await roundTrip(transport, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0" }
    }
  });
  const sessionId = init.sessionId;
  if (!sessionId) throw new Error("initialize did not return an mcp-session-id");
  await roundTrip(transport, sessionId, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  return sessionId;
}

async function callTool(transport: McpTransport, sessionId: string, name: string, args: Record<string, unknown>) {
  const response = await roundTrip(transport, sessionId, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args }
  });
  return response.body?.result ?? response.body;
}

function contentText(result: { content?: Array<{ type: string; text: string }> }) {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

const scopedArgs = { from: "2026-08-01", to: "2026-08-31", branchId: "b1", accessScope: { branchIds: ["b1"], canViewRevenue: true } };

describe("MCP data server", () => {
  it("serves the four allow-listed analytics tools", async () => {
    const transport = createMcpServer({ clickhouse: fakeClickhouse([]), allowRevenue: true });
    const sessionId = await initSession(transport);
    const response = await roundTrip(transport, sessionId, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    const tools = response.body?.result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_cycles_daily",
      "get_revenue_daily",
      "get_temperature_curve",
      "get_utilization_heatmap"
    ]);
  });

  it("rejects revenue calls without canViewRevenue in the scope", async () => {
    const transport = createMcpServer({ clickhouse: fakeClickhouse([]), allowRevenue: true });
    const sessionId = await initSession(transport);
    const result = await callTool(transport, sessionId, "get_revenue_daily", {
      ...scopedArgs,
      accessScope: { branchIds: ["b1"], canViewRevenue: false }
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(contentText(result))).toEqual({ error: { code: "revenue_forbidden", message: "Revenue data requires an owner or manager scope" } });
  });

  it("rejects a branch outside the declared scope before querying", async () => {
    const clickhouse = fakeClickhouse([{ match: /./, rows: [] }]);
    const transport = createMcpServer({ clickhouse, allowRevenue: true });
    const sessionId = await initSession(transport);
    const result = await callTool(transport, sessionId, "get_cycles_daily", {
      ...scopedArgs,
      branchId: "b2"
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(contentText(result))).toEqual({ error: { code: "branch_out_of_scope", message: "The requested branch is outside the caller's scope" } });
    expect(clickhouse).not.toHaveBeenCalled();
  });

  it("accepts a tenant-wide scope with an empty branchId and returns the synthetic envelope", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_machine_usage/, rows: syntheticDailyRows }]);
    const transport = createMcpServer({ clickhouse, allowRevenue: true });
    const sessionId = await initSession(transport);
    const result = await callTool(transport, sessionId, "get_cycles_daily", {
      ...scopedArgs,
      branchId: "",
      accessScope: { branchIds: ["*"], canViewRevenue: false }
    });

    expect(result.isError).toBeUndefined();
    const envelope = JSON.parse(contentText(result));
    expect(envelope.meta.dataSource).toBe("synthetic");
    expect(envelope.meta.range).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(envelope.data[0]).toEqual({ date: "2026-08-01", branchId: "b1", branchName: "SYNTH-A", cycles: 31, avgDurationMin: 38.2 });
  });

  it("returns revenue data in satang when the scope allows revenue", async () => {
    const clickhouse = fakeClickhouse([{ match: /fact_machine_usage/, rows: syntheticDailyRows }]);
    const transport = createMcpServer({ clickhouse, allowRevenue: true });
    const sessionId = await initSession(transport);
    const result = await callTool(transport, sessionId, "get_revenue_daily", scopedArgs);

    const envelope = JSON.parse(contentText(result));
    expect(envelope.data[0]).toEqual({ date: "2026-08-01", branchId: "b1", branchName: "SYNTH-A", revenueSatang: 184000, cycles: 31 });
  });

  it("disables revenue tools when the service token capability flag is off", async () => {
    const transport = createMcpServer({ clickhouse: fakeClickhouse([]), allowRevenue: false });
    const sessionId = await initSession(transport);
    const result = await callTool(transport, sessionId, "get_revenue_daily", scopedArgs);

    expect(result.isError).toBe(true);
    expect(JSON.parse(contentText(result))).toEqual({ error: { code: "revenue_disabled", message: "Revenue tools are disabled for this service token" } });
  });

  it("rejects an invalid date range", async () => {
    const transport = createMcpServer({ clickhouse: fakeClickhouse([]), allowRevenue: true });
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

// keep type import used for editors that prune on save
export type { ClickHouseExecutor };
