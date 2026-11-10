import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../access-store";

const accessStore = vi.hoisted(() => ({
  findLiffUser: vi.fn(),
  resolveUserPrincipal: vi.fn(),
  recordPendingLiffAccessRequest: vi.fn()
}));

const aiSettings = vi.hoisted(() => ({
  getAiSettingsWithKey: vi.fn(() => ({
    baseUrl: "http://gateway.test",
    apiKey: "test-key",
    model: "test-model",
    systemPrompt: "test-prompt",
    temperature: 70
  })),
  updateAiSettings: vi.fn(),
  addChatMessage: vi.fn(),
  listChatMessages: vi.fn(),
  isOwner: vi.fn(() => true)
}));

vi.mock("../access-store", () => accessStore);
vi.mock("../ai-settings", () => aiSettings);

import { db, initializeDatabase } from "../db";
import { resolveLineIdentity, roleLabel, scopeForPrincipal } from "./identity";
import { answerForMessage } from "./conversation";
import { createBotHandler } from "./index";
import { allTurns } from "./memory";

// The handler now writes a chat_turn per answer, so the real schema has to exist
// in the test database.
initializeDatabase();

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
    // AI SDK Chat Completions streaming: one text delta, then DONE.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        `data: {"choices":[{"delta":{"content":"รายได้รวม 184,000 บาท"},"finish_reason":null}]}\n\ndata: [DONE]\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    );

    const answer = await answerForMessage(
      {
        userText: "รายได้เท่าไหร่",
        lineUserId: "line-2",
        roleLabel: "manager",
        branchContext: "SYNTH-A (b1)",
        scope: { branchIds: ["b1"], canViewRevenue: true }
      },
      { mcp, fetchImpl }
    );

    expect(answer.text).toBe("รายได้รวม 184,000 บาท");
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
      .mockResolvedValueOnce(
        new Response(
          `data: {"choices":[{"delta":{"content":"","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_cycles_daily","arguments":"{\\"from\\":\\"2026-08-01\\",\\"to\\":\\"2026-08-31\\",\\"branchId\\":\\"b1\\",\\"accessScope\\":{\\"branchIds\\":[\\"*\\"],\\"canViewRevenue\\":true}}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          `data: {"choices":[{"delta":{"content":"มีรอบการซัก 31 รอบ"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
      );

    const answer = await answerForMessage(
      {
        userText: "รอบซักวันนี้กี่รอบ",
        lineUserId: "line-2",
        roleLabel: "manager",
        branchContext: "SYNTH-A (b1)",
        scope: { branchIds: ["b1"], canViewRevenue: true }
      },
      { mcp, fetchImpl }
    );

    expect(answer.text).toBe("มีรอบการซัก 31 รอบ");
    expect(mcp.callTool).toHaveBeenCalledWith(
      "get_cycles_daily",
      expect.objectContaining({ branchId: "b1" }),
      { branchIds: ["b1"], canViewRevenue: true }
    );
    expect(mcp.callTool.mock.calls[0][1]).not.toHaveProperty("accessScope");
    // The tool result (JSON text) must be fed back to the model as the tool message.
    const secondCallBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(secondCallBody.messages.some((m: { role: string }) => m.role === "tool")).toBe(true);
  });
});

describe("bot webhook handler", () => {
  beforeEach(() => {
    process.env.LINE_CHANNEL_SECRET = "test-secret";
    // The bot now writes chat_turn rows, and the test database is a file that
    // survives between runs: without this, a second run sees the first run's
    // conversation and the history assertion counts turns from the previous test.
    db.$client.prepare("DELETE FROM chat_turn").run();
    vi.clearAllMocks();
  });

  function lineSignature(body: string) {
    return createHmac("sha256", "test-secret").update(body).digest("base64");
  }

  it("rejects an invalid signature before processing events", async () => {
    const adapter = { platform: "line" as const, sendText: vi.fn().mockResolvedValue(undefined) };
    const handler = createBotHandler(
      { mcpUrl: "", mcpToken: "", lineChannelAccessToken: undefined, clickhouse: vi.fn() },
      adapter
    );

    const response = await handler.handle(JSON.stringify({ events: [] }), "wrong-signature");

    expect(response.status).toBe(401);
    expect(adapter.sendText).not.toHaveBeenCalled();
  });

  it("pushes a no-access reply to an unknown LINE user", async () => {
    const adapter = { platform: "line" as const, sendText: vi.fn().mockResolvedValue(undefined) };
    const handler = createBotHandler(
      { mcpUrl: "", mcpToken: "", lineChannelAccessToken: undefined, clickhouse: vi.fn() },
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
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        `data: {"choices":[{"delta":{"content":"สาขา SYNTH-A มี 31 รอบ"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    );
    const handler = createBotHandler(
      {
        mcpUrl: "",
        mcpToken: "",
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

  // A reply is free; a push is charged against the 300-a-month allowance that the
  // alerts need. The token has to reach the adapter or every chat answer costs a
  // message.
  it("forwards the reply token so the answer is free", async () => {
    const adapter = { platform: "line" as const, sendText: vi.fn().mockResolvedValue(undefined) };
    const mcp = {
      listTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn()
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        `data: {"choices":[{"delta":{"content":"สวัสดี"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    );
    const handler = createBotHandler(
      { mcpUrl: "", mcpToken: "", lineChannelAccessToken: undefined, clickhouse: vi.fn().mockResolvedValue([]), fetchImpl },
      adapter,
      mcp
    );
    accessStore.findLiffUser.mockReturnValue({ id: "u1", name: "Manager", email: "m@e.com" });
    accessStore.resolveUserPrincipal.mockReturnValue(manager);

    await handler.handleTextEvent({
      type: "message",
      message: { type: "text", text: "สวัสดี" },
      source: { userId: "line-3" },
      replyToken: "rt-abc"
    });

    expect(adapter.sendText).toHaveBeenCalledWith("line-3", "สวัสดี", { replyToken: "rt-abc" });
  });

  // P1: the typing indicator, the queue, the memory write, and history on the wire.
  function harness(options: { delayMs?: number } = {}) {
    const adapter = {
      platform: "line" as const,
      sendText: vi.fn().mockResolvedValue("reply" as const),
      showLoading: vi.fn().mockResolvedValue(undefined)
    };
    const mcp = { listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn() };
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit): Promise<Response> => {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return new Response(
        `data: {"choices":[{"delta":{"content":"ตอบแล้ว"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });
    const handler = createBotHandler(
      { mcpUrl: "", mcpToken: "", lineChannelAccessToken: undefined, clickhouse: vi.fn().mockResolvedValue([]), fetchImpl },
      adapter,
      mcp
    );
    return { adapter, handler, fetchImpl };
  }

  it("shows a typing indicator before it starts thinking", async () => {
    const { adapter, handler } = harness();
    accessStore.findLiffUser.mockReturnValue({ id: "u1", name: "Owner", email: "o@e.com" });
    accessStore.resolveUserPrincipal.mockReturnValue(owner);

    await handler.handleTextEvent({
      type: "message",
      message: { type: "text", text: "สวัสดี" },
      source: { userId: "line-loading" },
      replyToken: "rt-1"
    });

    expect(adapter.showLoading).toHaveBeenCalledWith("line-loading");
  });

  it("answers two quick messages in order instead of dropping the second", async () => {
    const { adapter, handler } = harness({ delayMs: 25 });
    accessStore.findLiffUser.mockReturnValue({ id: "u1", name: "Owner", email: "o@e.com" });
    accessStore.resolveUserPrincipal.mockReturnValue(owner);

    const first = handler.handleTextEvent({
      type: "message",
      message: { type: "text", text: "คำถามแรก" },
      source: { userId: "line-queue" },
      replyToken: "rt-a"
    });
    const second = handler.handleTextEvent({
      type: "message",
      message: { type: "text", text: "คำถามสอง" },
      source: { userId: "line-queue" },
      replyToken: "rt-b"
    });
    await Promise.all([first, second]);

    const sent = adapter.sendText.mock.calls.map((call) => call[1]);
    expect(sent).toEqual(["ตอบแล้ว", "ตอบแล้ว"]);
    // Both reached the model — the second message was queued, not discarded.
    expect(adapter.sendText).toHaveBeenCalledTimes(2);
  });

  it("records the turn, so the next question has something to refer to", async () => {
    const { handler } = harness();
    accessStore.findLiffUser.mockReturnValue({ id: "u1", name: "Owner", email: "o@e.com" });
    accessStore.resolveUserPrincipal.mockReturnValue(owner);

    await handler.handleTextEvent({
      type: "message",
      message: { type: "text", text: "รอบซักวันนี้" },
      source: { userId: "line-memory" },
      replyToken: "rt-m"
    });

    const [row] = allTurns("line-memory");
    expect(row).toMatchObject({
      lineUserId: "line-memory",
      userText: "รอบซักวันนี้",
      answerText: "ตอบแล้ว",
      delivered: "reply"
    });
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("sends the previous turns as messages, not as one pasted prompt", async () => {
    const { handler, fetchImpl } = harness();
    accessStore.findLiffUser.mockReturnValue({ id: "u1", name: "Owner", email: "o@e.com" });
    accessStore.resolveUserPrincipal.mockReturnValue(owner);
    const userId = "line-history";

    await handler.handleTextEvent({
      type: "message",
      message: { type: "text", text: "ภาพรวมวันนี้" },
      source: { userId },
      replyToken: "rt-1"
    });
    await handler.handleTextEvent({
      type: "message",
      message: { type: "text", text: "แล้วเมื่อวานล่ะ" },
      source: { userId },
      replyToken: "rt-2"
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    // The SDK puts the system prompt in the same array; the conversation is what
    // follows it, and it must alternate user/assistant ending on the new question.
    const conversation = body.messages.filter((message) => message.role !== "system");
    expect(conversation.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(conversation[0].content).toBe("ภาพรวมวันนี้");
    expect(conversation[2].content).toBe("แล้วเมื่อวานล่ะ");
  });
});
