import type { AccessScope } from "./identity";
import type { McpClientLike } from "./mcp-client";
import { getAiSettingsWithKey } from "../ai-settings";
import { agenticAnswer } from "../llm-client";
import { branchLabel, buildAssistantSystemPrompt } from "../llm-prompt";

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

function buildSystemPrompt(ctx: ConversationContext, ownerPrompt: string, toolNames: readonly string[]): string {
  // The wildcard scope means tenant-wide, so the human label wins; otherwise
  // prefer the caller's resolved branch name and fall back to the raw ids.
  const branches = ctx.scope.branchIds.includes("*")
    ? branchLabel(["*"])
    : ctx.branchContext || branchLabel(ctx.scope.branchIds);
  return buildAssistantSystemPrompt({
    ownerPrompt,
    roleLabel: ctx.roleLabel,
    branches,
    toolNames,
    canViewRevenue: ctx.scope.canViewRevenue
  });
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

  const tools = await deps.mcp.listTools(ctx.scope);
  // The SDK executes tool calls itself; each MCP tool becomes an SDK tool
  // whose execute routes back to the MCP data server.
  return agenticAnswer(settings.baseUrl, settings.apiKey, settings.model, {
    instructions: buildSystemPrompt(ctx, settings.systemPrompt, tools.map((tool) => tool.name)),
    input: ctx.userText,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown> | undefined
    })),
    execute: async (name, args) => {
      const toolArgs = { ...args };
      delete toolArgs.accessScope;
      return toolResultText(await deps.mcp.callTool(name, toolArgs, ctx.scope));
    },
    temperature: settings.temperature,
    // Single tool round-trip in v1 — enough for a branch-scoped question.
    maxSteps: 2,
    fetchImpl: deps.fetchImpl
  });
}