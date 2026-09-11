import type { AccessScope } from "./identity";
import type { McpClientLike } from "./mcp-client";
import { getAiSettingsWithKey } from "../ai-settings";
import { agenticAnswer } from "../llm-client";

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
  // The SDK executes tool calls itself; each MCP tool becomes an SDK tool
  // whose execute routes back to the MCP data server.
  return agenticAnswer(settings.baseUrl, settings.apiKey, settings.model, {
    instructions: buildSystemPrompt(ctx),
    input: ctx.userText,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown> | undefined
    })),
    execute: async (name, args) => toolResultText(await deps.mcp.callTool(name, args)),
    temperature: settings.temperature,
    // Single tool round-trip in v1 — enough for a branch-scoped question.
    maxSteps: 2,
    fetchImpl: deps.fetchImpl
  });
}