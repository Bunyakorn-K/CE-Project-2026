import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../access-store";

const accessStore = vi.hoisted(() => ({
  findLiffUser: vi.fn(),
  resolveUserPrincipal: vi.fn(),
  recordPendingLiffAccessRequest: vi.fn()
}));

vi.mock("../access-store", () => accessStore);

import { resolveLineIdentity, roleLabel, scopeForPrincipal } from "./identity";
import { answerForMessage } from "./conversation";
import { createBotHandler } from "./index";

const owner: Principal = {
  source: "liff",
  user: { id: "u1", name: "Owner", email: "o@e.com" },
  grants: [{ id: "g1", role: "owner", branchId: null }]
};
const manager: Principal = {
  source: "liff",
  user: { id: "u2", name: "Manager", email: "m@e.com" },
  grants: [{ id: "g2", role: "manager", branchId: "b1" }]
};
const technician: Principal = {
  source: "liff",
  user: { id: "u3", name: "Tech", email: "t@e.com" },
  grants: [{ id: "g3", role: "technician", branchId: "b2" }]
};

describe("bot identity", () => {
  it("owner scope is tenant-wide with revenue", () => {
    expect(scopeForPrincipal(owner)).toEqual({ branchIds: ["*"], canViewRevenue: true });
  });

  it("manager scope is their branch with revenue", () => {
    expect(scopeForPrincipal(manager)).toEqual({ branchIds: ["b1"], canViewRevenue: true });
  });

  it("technician scope is their branch without revenue", () => {
    expect(scopeForPrincipal(technician)).toEqual({ branchIds: ["b2"], canViewRevenue: false });
  });

  it("role label dedupes roles", () => {
    expect(roleLabel(owner)).toBe("owner");
    expect(roleLabel(manager)).toBe("manager");
  });

  it("unknown LINE user resolves to unknown_user", () => {
    accessStore.findLiffUser.mockReturnValue(null);
    expect(resolveLineIdentity("line-unknown")).toEqual({ ok: false, code: "unknown_user" });
  });

  it("known user without grants resolves to no_grants", () => {
    accessStore.findLiffUser.mockReturnValue({ id: "u1", name: "N", email: "n@e.com" });
    accessStore.resolveUserPrincipal.mockReturnValue({ ...owner, grants: [] });
    expect(resolveLineIdentity("line-1")).toEqual({ ok: false, code: "no_grants" });
  });
});

describe("bot conversation loop", () => {
  const mcpTools = [
    {
      name: "get_cycles_daily",
      description: "Daily cycles",
      inputSchema: { type: "object", properties: { branchId: { type: "string" } } }
    }
  ];

  it("returns the LLM answer when no tool call is requested", async () => {
    const mcp = { listTools: vi.fn().mockResolvedValue(mcpTools), callTool: vi.fn() };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { role: "assistant", content: "รายได้รวม 184,000 บาท" } }] })
    });

    const answer = await answerForMessage(
      { userText: "รายได้เท่าไหร่", roleLabel: "manager", branchContext: "SYNTH-A (b1)", scope: { branchIds: ["b1"], canViewRevenue: true } },
      { mcp, openRouterKey: "key", model: "test-model", fetchImpl }
    );

    expect(answer).toBe("รายได้รวม 184,000 บาท");
    expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it("routes a tool call to the MCP server and answers from its result", async () => {
    const mcp = {
      listTools: vi.fn().mockResolvedValue(mcpTools),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"meta":{"dataSource":"synthetic"},"data":[{"date":"2026-08-01","cycles":31}]}' }]
      })
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "get_cycles_daily", arguments: '{"from":"2026-08-01","to":"2026-08-31","branchId":"b1"}' } }]
            }
          }]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { role: "assistant", content: "มีรอบการซัก 31 รอบ" } }] })
      });

    const answer = await answerForMessage(
      { userText: "รอบซักวันนี้กี่รอบ", roleLabel: "manager", branchContext: "SYNTH-A (b1)", scope: { branchIds: ["b1"], canViewRevenue: true } },
      { mcp, openRouterKey: "key", model: "test-model", fetchImpl }
    );

    expect(answer).toBe("มีรอบการซัก 31 รอบ");
    expect(mcp.callTool).toHaveBeenCalledWith("get_cycles_daily", expect.objectContaining({ branchId: "b1" }));
    // The tool result (JSON text) must be fed back to the model as the tool message.
    const secondCallBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(secondCallBody.messages.some((m: { role: string }) => m.role === "tool")).toBe(true);
  });
});

describe("bot webhook handler", () => {
  beforeEach(() => {
    process.env.LINE_CHANNEL_SECRET = "test-secret";
    vi.clearAllMocks();
  });

  function lineSignature(body: string) {
    return createHmac("sha256", "test-secret").update(body).digest("base64");
  }

  it("rejects an invalid signature before processing events", async () => {
    const adapter = { platform: "line" as const, sendText: vi.fn().mockResolvedValue(undefined) };
    const handler = createBotHandler(
      { mcpUrl: "", mcpToken: "", openRouterKey: "", model: "m", lineChannelAccessToken: undefined, clickhouse: vi.fn() },
      adapter
    );

    const response = await handler.handle(JSON.stringify({ events: [] }), "wrong-signature");

    expect(response.status).toBe(401);
    expect(adapter.sendText).not.toHaveBeenCalled();
  });

  it("pushes a no-access reply to an unknown LINE user", async () => {
    const adapter = { platform: "line" as const, sendText: vi.fn().mockResolvedValue(undefined) };
    const handler = createBotHandler(
      { mcpUrl: "", mcpToken: "", openRouterKey: "", model: "m", lineChannelAccessToken: undefined, clickhouse: vi.fn() },
      adapter
    );
    accessStore.findLiffUser.mockReturnValue(null);

    const body = JSON.stringify({
      events: [{ type: "message", message: { type: "text", text: "สวัสดี" }, source: { userId: "line-x" } }]
    });
    await handler.handleTextEvent(JSON.parse(body).events[0]);

    expect(accessStore.recordPendingLiffAccessRequest).toHaveBeenCalledWith(
      expect.objectContaining({ lineUserId: "line-x" })
    );
    expect(adapter.sendText).toHaveBeenCalledWith("line-x", expect.stringContaining("ยังไม่ได้รับสิทธิ์"));
  });

  it("answers a granted user by calling the LLM through the MCP tool loop", async () => {
    const adapter = { platform: "line" as const, sendText: vi.fn().mockResolvedValue(undefined) };
    const mcp = {
      listTools: vi.fn().mockResolvedValue([
        { name: "get_cycles_daily", description: "Daily cycles", inputSchema: { type: "object", properties: {} } }
      ]),
      callTool: vi.fn()
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { role: "assistant", content: "สาขา SYNTH-A มี 31 รอบ" } }] })
    });
    const handler = createBotHandler(
      {
        mcpUrl: "",
        mcpToken: "",
        openRouterKey: "key",
        model: "m",
        lineChannelAccessToken: undefined,
        clickhouse: vi.fn().mockResolvedValue([]),
        fetchImpl
      },
      adapter,
      mcp
    );
    accessStore.findLiffUser.mockReturnValue({ id: "u1", name: "Manager", email: "m@e.com" });
    accessStore.resolveUserPrincipal.mockReturnValue(manager);

    const body = JSON.stringify({
      events: [{ type: "message", message: { type: "text", text: "รอบซักเท่าไหร่" }, source: { userId: "line-2" } }]
    });
    await handler.handleTextEvent(JSON.parse(body).events[0]);

    expect(adapter.sendText).toHaveBeenCalledWith("line-2", "สาขา SYNTH-A มี 31 รอบ");
    expect(fetchImpl).toHaveBeenCalled();
  });
});
