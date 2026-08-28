import { recordPendingLiffAccessRequest } from "../access-store";
import type { ClickHouseExecutor } from "../analytics/clickhouse";
import { listBranchNames } from "../analytics/queries";
import { isValidLineSignature } from "../line";
import type { PlatformAdapter } from "./adapter";
import type { AccessScope } from "./identity";
import { resolveLineIdentity, roleLabel } from "./identity";
import { answerForMessage } from "./conversation";
import { LineAdapter } from "./line-adapter";
import { McpClient, type McpClientLike } from "./mcp-client";

export type BotDeps = {
  mcpUrl: string;
  mcpToken: string;
  openRouterKey: string;
  model: string;
  lineChannelAccessToken: string | undefined;
  clickhouse: ClickHouseExecutor;
  fetchImpl?: typeof fetch;
};

type LineTextEvent = {
  type: "message";
  message: { type: "text"; text: string };
  source?: { userId?: string; displayName?: string };
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
  const busy = new Set<string>();

  async function handleTextEvent(event: LineTextEvent): Promise<void> {
    const userId = event.source?.userId;
    if (!userId) return;
    if (busy.has(userId)) return; // drop overlap; the user already has an answer in flight
    busy.add(userId);
    try {
      const identity = resolveLineIdentity(userId);
      if (!identity.ok) {
        if (identity.code === "unknown_user") {
          recordPendingLiffAccessRequest({
            lineUserId: userId,
            displayName: event.source?.displayName ?? "LINE bot user"
          });
        }
        await adapter.sendText(userId, "บัญชี LINE นี้ยังไม่ได้รับสิทธิ์ใช้งาน LaundryTwin กรุณาติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์");
        return;
      }
      const branchContext = await branchContextFor(identity.scope, deps.clickhouse);
      const answer = await answerForMessage(
        {
          userText: event.message.text,
          roleLabel: roleLabel(identity.principal),
          branchContext,
          scope: identity.scope
        },
        { mcp, openRouterKey: deps.openRouterKey, model: deps.model, fetchImpl: deps.fetchImpl }
      );
      await adapter.sendText(userId, answer);
    } catch (error) {
      console.error("LaundryTwin bot error", error);
      try {
        await adapter.sendText(userId, "ขออภัย เกิดข้อผิดพลาดในการประมวลผล ลองถามใหม่อีกครั้ง");
      } catch {
        // reply is best-effort; never let a reply failure crash the webhook
      }
    } finally {
      busy.delete(userId);
    }
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
