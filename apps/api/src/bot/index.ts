import { recordPendingLiffAccessRequest } from "../access-store";
import type { ClickHouseExecutor } from "../analytics/clickhouse";
import { listBranchNames } from "../analytics/queries";
import { isValidLineSignature } from "../line";
import type { PlatformAdapter } from "./adapter";
import type { AccessScope } from "./identity";
import { resolveLineIdentity, roleLabel } from "./identity";
import { answerForMessage } from "./conversation";
import { appendTurn } from "./memory";
import { LineAdapter } from "./line-adapter";
import { McpClient, type McpClientLike } from "./mcp-client";

export type BotDeps = {
  mcpUrl: string;
  mcpToken: string;
  lineChannelAccessToken: string | undefined;
  clickhouse: ClickHouseExecutor;
  fetchImpl?: typeof fetch;
};

type LineTextEvent = {
  type: "message";
  message: { type: "text"; text: string };
  source?: { userId?: string; displayName?: string };
  /** Free reply path; absent on events that are not a user message. */
  replyToken?: string;
};

async function branchContextFor(scope: AccessScope, clickhouse: ClickHouseExecutor): Promise<string> {
  try {
    const branches = await listBranchNames(clickhouse);
    const allowed = scope.branchIds.includes("*")
      ? branches
      : branches.filter((branch) => scope.branchIds.includes(branch.branchId));
    return allowed.map((branch) => `${branch.branchName} (${branch.branchId})`).join(", ");
  } catch {
    return "";
  }
}

export function createBotHandler(deps: BotDeps, adapterOverride?: PlatformAdapter, mcpOverride?: McpClientLike) {
  const adapter = adapterOverride ?? new LineAdapter(deps.lineChannelAccessToken);
  const mcp = mcpOverride ?? new McpClient(deps.mcpUrl, deps.mcpToken);
  /**
   * One answer at a time per LINE user, in order.
   *
   * This was a `Set`: a second message that arrived while the first was in flight
   * was silently dropped, so a user who typed twice got one answer and no reason.
   * A queue is the honest behaviour — the second message waits, then answers, and
   * the conversation reads as a conversation.
   */
  const inFlight = new Map<string, Promise<void>>();

  function enqueue(userId: string, task: () => Promise<void>): Promise<void> {
    const previous = inFlight.get(userId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (inFlight.get(userId) === next) inFlight.delete(userId);
      });
    inFlight.set(userId, next);
    return next;
  }

  /**
   * Answer with a free reply when the event carried a token, and a charged push
   * otherwise. Written as two calls rather than one with `undefined`, so a caller
   * that has no token sends exactly what it sent before this existed.
   */
  async function reply(userId: string, text: string, replyToken?: string) {
    if (replyToken) {
      return adapter.sendText(userId, text, { replyToken });
    }
    return adapter.sendText(userId, text);
  }

  async function answerOne(event: LineTextEvent): Promise<void> {
    const userId = event.source?.userId;
    if (!userId) return;
    const startedAt = Date.now();
    try {
      const identity = resolveLineIdentity(userId);
      if (!identity.ok) {
        if (identity.code === "unknown_user") {
          recordPendingLiffAccessRequest({
            lineUserId: userId,
            displayName: event.source?.displayName ?? "LINE bot user"
          });
        }
        await reply(
          userId,
          "บัญชี LINE นี้ยังไม่ได้รับสิทธิ์ใช้งาน LaundryTwin กรุณาติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์",
          event.replyToken
        );
        return;
      }
      // Typing indicator first: the model plus a tool call takes seconds, and
      // silence reads as "broken". Free, and it covers the whole answer.
      void adapter.showLoading?.(userId);

      const branchContext = await branchContextFor(identity.scope, deps.clickhouse);
      const answer = await answerForMessage(
        {
          userText: event.message.text,
          lineUserId: userId,
          roleLabel: roleLabel(identity.principal),
          branchContext,
          scope: identity.scope,
          actorUserId: identity.principal.user.id
        },
        { mcp, fetchImpl: deps.fetchImpl }
      );
      const delivered = await reply(userId, answer.text, event.replyToken);

      // The turn is the bot's memory and its record: without this row a follow-up
      // question has nothing to refer to, and nobody can see what the bot said.
      appendTurn({
        lineUserId: userId,
        userText: event.message.text,
        answerText: answer.text,
        model: answer.model,
        steps: answer.steps,
        toolCalls: answer.toolCalls,
        latencyMs: Date.now() - startedAt,
        delivered: delivered === "reply" || delivered === "push" ? delivered : undefined
      });
    } catch (error) {
      console.error("LaundryTwin bot error", error);
      try {
        await reply(userId, "ขออภัย เกิดข้อผิดพลาดในการประมวลผล ลองถามใหม่อีกครั้ง", event.replyToken);
      } catch {
        // reply is best-effort; never let a reply failure crash the webhook
      }
    }
  }

  /** Queue the answer for this user; the webhook returns before it runs. */
  function handleTextEvent(event: LineTextEvent): Promise<void> {
    const userId = event.source?.userId;
    if (!userId) return Promise.resolve();
    return enqueue(userId, () => answerOne(event));
  }

  async function handle(rawBody: string, signature: string | undefined): Promise<Response> {
    if (!isValidLineSignature(rawBody, signature)) {
      return new Response(JSON.stringify({ error: "Invalid LINE webhook signature" }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    }
    const payload = JSON.parse(rawBody) as { events: LineTextEvent[] };
    for (const event of payload.events) {
      if (event.type === "message" && event.message.type === "text") {
        // Ack the webhook immediately; answers are pushed async because the
        // LLM + tool loop can exceed LINE's 60s reply window.
        void handleTextEvent(event);
      }
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }

  return { handle, handleTextEvent };
}
