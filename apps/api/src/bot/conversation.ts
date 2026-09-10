import type { AccessScope } from "./identity";
import type { McpClientLike } from "./mcp-client";
import { getAiSettingsWithKey } from "../ai-settings";

export type ConversationContext = {
  userText: string;
  roleLabel: string;
  branchContext: string;
  scope: AccessScope;
};

export type ConversationDeps = {
  mcp: McpClientLike;
  fetchImpl?: typeof fetch;
};

function buildSystemPrompt(ctx: ConversationContext): string {
  const branches = ctx.scope.branchIds.includes("*")
    ? "ทุกสาขา"
    : ctx.branchContext || ctx.scope.branchIds.join(", ");
  return [
    "คุณคือผู้ช่วยข้อมูลของระบบ LaundryTwin สำหรับผู้จัดการหรือเจ้าของร้านซักรีด",
    `ผู้ใช้มีสิทธิ์: ${ctx.roleLabel}`,
    `สาขาที่เข้าถึงได้: ${branches}`,
    "ตอบเป็นภาษาไทย กระชับ และอ้างอิงข้อมูลจากเครื่องมือ (tools) เท่านั้น",
    "ถ้าข้อมูลที่ได้เป็นข้อมูลจำลอง (dataSource เป็น synthetic หรือ mixed) ให้บอกผู้ใช้อย่างชัดเจนว่าเป็นข้อมูลจำลอง",
    "ตัวเลขเงินในข้อมูลเป็นสตางค์ (satang) ให้แปลงเป็นบาทก่อนแสดง",
    "ถ้าผู้ใช้ถามสิ่งที่ไม่มีข้อมูล ให้ตอบตรงๆ ว่าหาไม่เจอ อย่าเดาตัวเลข",
    "ถ้าผู้ใช้ขอข้อมูลรายได้แต่สิทธิ์ไม่ถึง ให้บอกว่าไม่มีสิทธิ์ดูข้อมูลรายได้"
  ].join("\n");
}

type ChatMessage = {
  role: string;
  content?: string | null;
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
};

type ToolResultItem = { type?: string; text?: string };

type McpCallResultLike = { content?: ToolResultItem[]; isError?: boolean };

async function chatOnce(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools: Array<Record<string, unknown>>,
  temperature: number,
  fetchImpl: typeof fetch = fetch
) {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature })
  });
  if (!response.ok) {
    throw new Error(`Gateway request failed with status ${response.status}`);
  }
  return response.json() as Promise<{
    choices?: Array<{ message?: { role?: string; content?: string | null; tool_calls?: Array<Record<string, unknown>> } }>;
  }>;
}

function toolResultText(result: McpCallResultLike): string {
  if (Array.isArray(result.content)) {
    return result.content
      .map((item) => (item?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(result);
}

export async function answerForMessage(ctx: ConversationContext, deps: ConversationDeps): Promise<string> {
  // The gateway config is now DB-driven (ai_settings) — the bot reads the
  // same baseURL/apiKey/model/prompt that the backoffice AI console manages.
  const settings = getAiSettingsWithKey();
  if (!settings.apiKey) {
    return "ขออภัย ยังไม่ได้ตั้งค่า API key ของผู้ช่วย กรุณาให้ผู้ดูแลระบบตั้งค่าในหน้า AI Console";
  }

  const tools = await deps.mcp.listTools();
  const openAiTools = tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object", properties: {} }
    }
  }));

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(ctx) },
    { role: "user", content: ctx.userText }
  ];

  const first = await chatOnce(
    settings.baseUrl,
    settings.apiKey,
    settings.model,
    messages,
    openAiTools,
    settings.temperature / 100,
    deps.fetchImpl
  );
  const firstMessage = first.choices?.[0]?.message;
  if (!firstMessage) return "ขออภัย เกิดข้อผิดพลาดในการติดต่อผู้ช่วย";

  const toolCalls = firstMessage.tool_calls;
  if (!toolCalls || toolCalls.length === 0) {
    return firstMessage.content ?? "ขออภัย ไม่สามารถหาคำตอบได้";
  }

  // Single tool round-trip in v1 — enough for a branch-scoped question.
  messages.push({ role: "assistant", content: firstMessage.content ?? "", tool_calls: toolCalls });
  for (const call of toolCalls) {
    const name = (call.function as { name?: string } | undefined)?.name ?? "";
    let args: Record<string, unknown> = {};
    try {
      const raw = (call.function as { arguments?: string } | undefined)?.arguments ?? "{}";
      const parsed: unknown = JSON.parse(raw);
      args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      args = {};
    }
    const result = await deps.mcp.callTool(name, args);
    messages.push({ role: "tool", tool_call_id: call.id as string, content: toolResultText(result) });
  }

  const second = await chatOnce(
    settings.baseUrl,
    settings.apiKey,
    settings.model,
    messages,
    openAiTools,
    settings.temperature / 100,
    deps.fetchImpl
  );
  return second.choices?.[0]?.message?.content ?? "ขออภัย ไม่สามารถหาคำตอบได้";
}