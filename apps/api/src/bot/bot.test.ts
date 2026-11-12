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

// The real module plus stubbed identity lookups: `acknowledgeAlert` must be the
// real one, because the postback test asserts the row it writes.
vi.mock("../access-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../access-store")>()),
  findLiffUser: accessStore.findLiffUser,
  resolveUserPrincipal: accessStore.resolveUserPrincipal,
  recordPendingLiffAccessRequest: accessStore.recordPendingLiffAccessRequest
}));
vi.mock("../ai-settings", () => aiSettings);

import { db, initializeDatabase } from "../db";
import { resolveLineIdentity, roleLabel, scopeForPrincipal } from "./identity";
import { answerForMessage, describeBotFailure } from "./conversation";
import { createBotHandler } from "./index";
import { allTurns } from "./memory";
import { alertAcknowledgement, alertNotification, chatPreference, user as userTable } from "../schema";
import { eq } from "drizzle-orm";

// The handler now writes a chat_turn per answer, so the real schema has to exist
// in the test database.
initializeDatabase();

/**
 * The (recipient, text) pairs that were sent.
 *
 * Asserting whole call arguments couples every test to whether the message happened
 * to carry quick replies; the text and the recipient are what the test is about.
 */
function sent(adapter: { sendText: { mock: { calls: unknown[][] } } }): unknown[][] {
  return adapter.sendText.mock.calls.map((call) => [call[0], call[1]]);
}

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
    expect(sent(adapter)).toContainEqual(["line-x", expect.stringContaining("ยังไม่ได้รับสิทธิ์")]);
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

    expect(sent(adapter)).toContainEqual(["line-2", "สาขา SYNTH-A มี 31 รอบ"]);
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

    expect(sent(adapter)).toContainEqual(["line-3", "สวัสดี"]);
    // The token still reaches the adapter — that is what makes the answer free.
    expect(adapter.sendText.mock.calls[0][2]).toEqual(expect.objectContaining({ replyToken: "rt-abc" }));
  });

  // P1: the typing indicator, the queue, the memory write, and history on the wire.
  function harness(
    options: { delayMs?: number; answer?: string; branches?: { branchId: string; branchName: string }[] } = {}
  ) {
    const adapter = {
      platform: "line" as const,
      sendText: vi.fn().mockResolvedValue("reply" as const),
      sendFlex: vi.fn().mockResolvedValue("reply" as const),
      showLoading: vi.fn().mockResolvedValue(undefined)
    };
    const mcp = { listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn() };
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit): Promise<Response> => {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const payload = JSON.stringify({ choices: [{ delta: { content: options.answer ?? "ตอบแล้ว" } }] });
      return new Response(`data: ${payload}\n\ndata: [DONE]\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });
    const handler = createBotHandler(
      { mcpUrl: "", mcpToken: "", lineChannelAccessToken: undefined, clickhouse: vi.fn().mockResolvedValue(options.branches ?? []), fetchImpl },
      adapter,
      mcp
    );
    return { adapter, handler, fetchImpl, mcp };
  }


  describe("asks which branch before answering an overview", () => {
    const TWO_BRANCHES = [
      { branchId: "b1", branchName: "about you.wash & dry แม่โจ้ - หลิ่งมื่น" },
      { branchId: "b2", branchName: "about you.wash & dry แม่โจ้ - ตลาดโขนเหลือง" }
    ];

    it("sends the picker instead of spending a model call", async () => {
      const userAsk = `line-branch-ask-${Date.now()}`;
      const { adapter, handler, fetchImpl } = harness({ branches: TWO_BRANCHES });
      accessStore.findLiffUser.mockReturnValue({ id: "u1", name: "Owner", email: "o@e.com" });
      accessStore.resolveUserPrincipal.mockReturnValue(owner);

      await handler.handleTextEvent({
        type: "message",
        message: { type: "text", text: "ภาพรวมวันนี้เป็นยังไง" },
        source: { userId: userAsk },
        replyToken: "rt-ask"
      });

      expect(fetchImpl).not.toHaveBeenCalled();
      const text = adapter.sendText.mock.calls[0][1] as string;
      expect(text).toContain("ต้องการดูสาขาไหน");
      const options = adapter.sendText.mock.calls[0][2] as { quickReplies?: { label: string; data: string }[] };
      expect(options.quickReplies?.map((reply) => reply.label)).toEqual([
        TWO_BRANCHES[0].branchName,
        TWO_BRANCHES[1].branchName,
        "ทุกสาขา"
      ]);
    });

    it("answers the held question when the branch is tapped", async () => {
      const userTap = `line-branch-tap-${Date.now()}`;
      const { adapter, handler, fetchImpl } = harness({ branches: TWO_BRANCHES, answer: "รายได้ 960 บาท" });
      accessStore.findLiffUser.mockReturnValue({ id: "u1", name: "Owner", email: "o@e.com" });
      accessStore.resolveUserPrincipal.mockReturnValue(owner);

      await handler.handleTextEvent({
        type: "message",
        message: { type: "text", text: "ภาพรวมวันนี้เป็นยังไง" },
        source: { userId: userTap },
        replyToken: "rt-ask-2"
      });
      adapter.sendText.mockClear();

      await handler.handlePostbackEvent({
        type: "postback",
        postback: { data: "pref:branch:b1" },
        source: { userId: userTap },
        replyToken: "rt-tap"
      });

      expect(fetchImpl).toHaveBeenCalled();
      // The answer arrives as a card, so the text lives in the flex payload and its
      // alt text rather than in sendText.
      const delivered = [
        ...adapter.sendFlex.mock.calls.map((call) => JSON.stringify(call.slice(0, 3))),
        ...adapter.sendText.mock.calls.map((call) => String(call[1]))
      ].join("\n");
      expect(delivered).toContain("960 บาท");
      // The answer is what they asked for, not a note about the preference.
      expect(delivered).not.toContain("จำไว้แล้ว");
    });

    it("does not ask twice: the second question answers", async () => {
      const userMemory = `line-branch-memory-${Date.now()}`;
      const { adapter, handler, fetchImpl } = harness({ branches: TWO_BRANCHES });
      accessStore.findLiffUser.mockReturnValue({ id: "u1", name: "Owner", email: "o@e.com" });
      accessStore.resolveUserPrincipal.mockReturnValue(owner);

      await handler.handleTextEvent({
        type: "message",
        message: { type: "text", text: "ภาพรวมวันนี้เป็นยังไง" },
        source: { userId: userMemory },
        replyToken: "rt-ask-3"
      });
      await handler.handlePostbackEvent({
        type: "postback",
        postback: { data: "pref:branch:b2" },
        source: { userId: userMemory },
        replyToken: "rt-tap-3"
      });
      fetchImpl.mockClear();
      adapter.sendText.mockClear();

      await handler.handleTextEvent({
        type: "message",
        message: { type: "text", text: "ภาพรวมวันนี้เป็นยังไง" },
        source: { userId: userMemory },
        replyToken: "rt-ask-4"
      });

      expect(fetchImpl).toHaveBeenCalled();
      expect(adapter.sendText.mock.calls[0][1] as string).not.toContain("ต้องการดูสาขาไหน");
    });
  });


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

  it("sends a card when the answer has structure, and text when it does not", async () => {
    // The user's complaint that started this: LINE does not render markdown, so the
    // answer arrived with its ** and ## intact. Structure becomes a flex bubble;
    // a plain sentence stays a message.
    const structured = harness({
      answer: "## ภาพรวมวันนี้\nรายได้: 1,240 บาท\nรอบซัก: 31 รอบ"
    });
    accessStore.findLiffUser.mockReturnValue({ id: "u1", name: "Owner", email: "o@e.com" });
    accessStore.resolveUserPrincipal.mockReturnValue(owner);

    await structured.handler.handleTextEvent({
      type: "message",
      message: { type: "text", text: "ภาพรวมวันนี้" },
      source: { userId: "line-card" },
      replyToken: "rt-card"
    });

    expect(structured.adapter.sendFlex).toHaveBeenCalledTimes(1);
    const [to, altText, contents, options] = structured.adapter.sendFlex.mock.calls[0];
    expect(to).toBe("line-card");
    expect(altText).toContain("ภาพรวมวันนี้");
    expect(JSON.stringify(contents)).toContain("1,240 บาท");
    expect(options).toEqual(expect.objectContaining({ replyToken: "rt-card" }));
    expect(structured.adapter.sendText).not.toHaveBeenCalled();

    const plain = harness({ answer: "ครับ วันนี้ร้านเปิดปกติครับ" });
    accessStore.resolveUserPrincipal.mockReturnValue(owner);
    await plain.handler.handleTextEvent({
      type: "message",
      message: { type: "text", text: "ร้านเปิดไหม" },
      source: { userId: "line-plain" },
      replyToken: "rt-plain"
    });

    expect(plain.adapter.sendFlex).not.toHaveBeenCalled();
    expect(sent(plain.adapter)).toContainEqual(["line-plain", "ครับ วันนี้ร้านเปิดปกติครับ"]);
    expect(plain.adapter.sendText.mock.calls[0][2]).toEqual(expect.objectContaining({ replyToken: "rt-plain" }));
  });

  it("falls back to text when the card itself cannot be sent", async () => {
    const { adapter, handler } = harness({ answer: "## หัวข้อ\nรายได้: 10 บาท" });
    adapter.sendFlex.mockRejectedValueOnce(new Error("LINE rejected the flex"));
    accessStore.resolveUserPrincipal.mockReturnValue(owner);
    accessStore.findLiffUser.mockReturnValue({ id: "u1", name: "Owner", email: "o@e.com" });

    await handler.handleTextEvent({
      type: "message",
      message: { type: "text", text: "รายได้" },
      source: { userId: "line-fallback" },
      replyToken: "rt-fb"
    });

    // The answer must still arrive, without the markdown the user complained about.
    expect(sent(adapter)).toContainEqual(["line-fallback", "หัวข้อ\nรายได้: 10 บาท"]);
    expect(adapter.sendText.mock.calls[0][2]).toEqual(expect.objectContaining({ replyToken: "rt-fb" }));
  });

  it("offers the branches this person may pick as a remembered preference", async () => {
    const { adapter, handler } = harness({
      branches: [
        { branchId: "b1", branchName: "แม่โจ้" },
        { branchId: "b2", branchName: "สุขุมวิท" }
      ]
    });
    accessStore.findLiffUser.mockReturnValue({ id: "u2", name: "Manager", email: "m@e.com" });
    accessStore.resolveUserPrincipal.mockReturnValue(manager);

    await handler.handleTextEvent({
      type: "message",
      message: { type: "text", text: "ตั้งสาขาประจำ" },
      source: { userId: "line-pref-pick" },
      replyToken: "rt-pick"
    });

    const [, text, options] = adapter.sendText.mock.calls[0] as [
      string,
      string,
      { quickReplies?: { label: string; data?: string }[] }
    ];
    expect(text).toContain("เลือกสาขาประจำ");
    // Only the manager's own branch is offered, and the button is a postback so the
    // branch id is exact instead of a name the model would have to match.
    expect(options.quickReplies).toEqual([{ label: "แม่โจ้", data: "pref:branch:b1" }]);
    // This costs no model call.
    expect(adapter.showLoading).not.toHaveBeenCalled();
  });

  it("remembers a branch the person may see, and refuses one they may not", async () => {
    const branches = [
      { branchId: "b1", branchName: "แม่โจ้" },
      { branchId: "b2", branchName: "สุขุมวิท" }
    ];
    const { adapter, handler } = harness({ branches });
    accessStore.findLiffUser.mockReturnValue({ id: "u2", name: "Manager", email: "m@e.com" });
    accessStore.resolveUserPrincipal.mockReturnValue(manager);

    await handler.handlePostbackEvent({
      type: "postback",
      postback: { data: "pref:branch:b1" },
      source: { userId: "line-pref-set" },
      replyToken: "rt-set"
    });
    expect(sent(adapter)).toContainEqual(["line-pref-set", expect.stringContaining("แม่โจ้")]);
    expect(db.select().from(chatPreference).where(eq(chatPreference.lineUserId, "line-pref-set")).all()).toHaveLength(1);

    // A postback is user input: b2 is not in this manager's scope and must not stick.
    await handler.handlePostbackEvent({
      type: "postback",
      postback: { data: "pref:branch:b2" },
      source: { userId: "line-pref-set" },
      replyToken: "rt-set-2"
    });
    expect(adapter.sendText.mock.calls[1][1]).toContain("ไม่ใช่สาขาที่คุณเข้าถึงได้");
    expect(db.select().from(chatPreference).where(eq(chatPreference.lineUserId, "line-pref-set")).all()).toHaveLength(1);
  });

  it("passes the remembered branch to the model and forgets it on request", async () => {
    const branches = [{ branchId: "b1", branchName: "แม่โจ้" }];
    const { adapter, handler, fetchImpl } = harness({ branches, answer: "ได้ครับ" });
    accessStore.findLiffUser.mockReturnValue({ id: "u2", name: "Manager", email: "m@e.com" });
    accessStore.resolveUserPrincipal.mockReturnValue(manager);

    await handler.handlePostbackEvent({
      type: "postback",
      postback: { data: "pref:branch:b1" },
      source: { userId: "line-pref-use" },
      replyToken: "rt-use"
    });

    await handler.handleTextEvent({
      type: "message",
      message: { type: "text", text: "ภาพรวมวันนี้" },
      source: { userId: "line-pref-use" },
      replyToken: "rt-use-2"
    });

    // The captured model request: the system prompt is the first message.
    const request = (fetchImpl.mock.calls[0] as unknown[])[1] as { body?: unknown } | undefined;
    const body = String(request?.body);
    expect(body).toContain("สาขาประจำ: แม่โจ้ (b1)");

    await handler.handleTextEvent({
      type: "message",
      message: { type: "text", text: "ลืมสาขาประจำ" },
      source: { userId: "line-pref-use" },
      replyToken: "rt-use-3"
    });
    expect(adapter.sendText.mock.calls.at(-1)?.[1]).toContain("ลืมสาขาประจำแล้ว");
    expect(db.select().from(chatPreference).where(eq(chatPreference.lineUserId, "line-pref-use")).all()).toHaveLength(0);
  });

  it("welcomes a new follower with a free reply", async () => {
    const { adapter, handler } = harness();
    accessStore.findLiffUser.mockReturnValue({ id: "u1", name: "Owner", email: "o@e.com" });
    accessStore.resolveUserPrincipal.mockReturnValue(owner);

    await handler.handleFollowEvent({ type: "follow", source: { userId: "line-follow" }, replyToken: "rt-f" });

    expect(adapter.sendText).toHaveBeenCalledTimes(1);
    const [to, text, options] = adapter.sendText.mock.calls[0];
    expect(to).toBe("line-follow");
    expect(text).toContain("ยินดีต้อนรับ");
    expect(options).toEqual({ replyToken: "rt-f" });
  });

  it("acknowledges an alert from a postback, and refuses one it may not touch", async () => {
    db.insert(userTable)
      .values({ id: "u1", name: "Owner", email: "o@e.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing()
      .run();
    const alertId = "gas:gas_run_a_pressure:declining:2026-11-09T14";
    db.delete(alertNotification).where(eq(alertNotification.irisAlertId, alertId)).run();
    db.delete(alertAcknowledgement).where(eq(alertAcknowledgement.irisAlertId, alertId)).run();
    db.insert(alertNotification)
      .values({
        id: `${alertId}:U-ack`,
        irisAlertId: alertId,
        lineUserId: "U-ack",
        branchId: "b1",
        machineId: null,
        severity: "warning",
        title: "แรงดันตก",
        message: "แรงดันลดลง",
        evidence: "{}",
        status: "sent",
        attemptedAt: new Date(),
        deliveredAt: new Date()
      })
      .onConflictDoNothing()
      .run();

    const { adapter, handler } = harness();
    accessStore.findLiffUser.mockReturnValue({ id: "u1", name: "Owner", email: "o@e.com" });
    accessStore.resolveUserPrincipal.mockReturnValue(owner);

    await handler.handlePostbackEvent({
      type: "postback",
      postback: { data: `ack:${alertId}` },
      source: { userId: "U-ack" },
      replyToken: "rt-ack"
    });

    expect(db.select().from(alertAcknowledgement).where(eq(alertAcknowledgement.irisAlertId, alertId)).all()).toHaveLength(1);
    expect(adapter.sendText.mock.calls[0][1]).toContain("รับทราบแล้ว");

    // A postback from someone with no grant for that branch is refused, not obeyed.
    accessStore.resolveUserPrincipal.mockReturnValue(technician);
    await handler.handlePostbackEvent({
      type: "postback",
      postback: { data: `ack:${alertId}` },
      source: { userId: "U-stranger" },
      replyToken: "rt-no"
    });
    expect(adapter.sendText.mock.calls[1][1]).toContain("ไม่มีสิทธิ์");
  });

  it("offers quick replies on the first answer only", async () => {
    const { adapter, handler } = harness();
    accessStore.findLiffUser.mockReturnValue({ id: "u1", name: "Owner", email: "o@e.com" });
    accessStore.resolveUserPrincipal.mockReturnValue(owner);

    await handler.handleTextEvent({
      type: "message",
      message: { type: "text", text: "สวัสดี" },
      source: { userId: "line-qr" },
      replyToken: "rt-1"
    });
    const firstOptions = adapter.sendText.mock.calls[0][2] as { quickReplies?: unknown[] };
    expect(firstOptions.quickReplies).toHaveLength(3);

    await handler.handleTextEvent({
      type: "message",
      message: { type: "text", text: "ขอบคุณ" },
      source: { userId: "line-qr" },
      replyToken: "rt-2"
    });
    const secondOptions = adapter.sendText.mock.calls[1][2] as { quickReplies?: unknown[] };
    expect(secondOptions.quickReplies).toBeUndefined();
  });

  it("tells the user the gateway is down instead of a generic apology", () => {
    // The failure this was written for: llm.kovaspire.com answered the container
    // with 502 and the user got "เกิดข้อผิดพลาดในการประมวลผล" — true, and useless.
    const gateway = describeBotFailure(
      Object.assign(new Error("Bad Gateway"), { name: "AI_APICallError", statusCode: 502 })
    );
    expect(gateway).toContain("เชื่อมต่อโมเดลไม่ได้");

    expect(describeBotFailure(Object.assign(new Error("retries exhausted"), { name: "AI_RetryError" }))).toContain(
      "เชื่อมต่อโมเดลไม่ได้"
    );
    expect(describeBotFailure(new Error("fetch failed"))).toContain("เชื่อมต่อโมเดลไม่ได้");
    expect(describeBotFailure(Object.assign(new Error("no output"), { name: "AI_NoOutputGeneratedError" }))).toContain(
      "เชื่อมต่อโมเดลไม่ได้"
    );

    // A model-level failure is worth retrying and must not be blamed on the gateway.
    expect(describeBotFailure(new Error("tool schema invalid"))).toBe(
      "ขออภัย เกิดข้อผิดพลาดในการประมวลผล ลองถามใหม่อีกครั้ง"
    );
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
