// Shared LLM client built on the Vercel AI SDK.
//
// The gateway (default: Bifrost) is OpenAI-compatible, so we talk to it via
// `createOpenAICompatible` with the DB-driven baseURL/apiKey/model from
// ai_settings. The SDK handles Chat Completions transport (including its SSE
// streaming variant) and tool-call round-trips via `stopWhen`.
//
// Callers:
//   - bot/conversation.ts : agentic loop over the allow-listed MCP tools
//   - ai-routes.ts        : plain chat for the backoffice playground

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { dynamicTool, jsonSchema, stepCountIs, streamText } from "ai";
import { z } from "zod";

export type GatewayToolDef = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type GatewayToolExecutor = (
  name: string,
  args: Record<string, unknown>
) => Promise<unknown>;

function toJsonSchema(parameters: Record<string, unknown> | undefined) {
  if (parameters && typeof parameters === "object") {
    // MCP inputSchema is a JSON Schema object — wrap it for the SDK.
    return jsonSchema(parameters as never);
  }
  return z.object({}).passthrough();
}

function toSdkTools(
  defs: GatewayToolDef[],
  execute: GatewayToolExecutor
): Record<string, ReturnType<typeof dynamicTool>> {
  const tools: Record<string, ReturnType<typeof dynamicTool>> = {};
  for (const def of defs) {
    if (!def.name) continue;
    // dynamicTool: input schema known only at runtime (MCP tool list).
    tools[def.name] = dynamicTool({
      description: def.description ?? "",
      inputSchema: toJsonSchema(def.parameters) as never,
      execute: async (input: unknown) => {
        const args =
          input && typeof input === "object" ? (input as Record<string, unknown>) : {};
        const result = await execute(def.name, args);
        return typeof result === "string" ? result : JSON.stringify(result);
      }
    });
  }
  return tools;
}

/** Build a chat model for the configured gateway (Bifrost by default). */
export function createGatewayModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  fetchImpl?: typeof fetch
) {
  const provider = createOpenAICompatible({
    name: "laundrytwin-gateway",
    baseURL: `${baseUrl.replace(/\/$/, "")}/v1`,
    apiKey,
    // Route the SDK's HTTP through the caller's fetch (tests inject a mock).
    ...(fetchImpl ? { fetch: fetchImpl as never } : {})
  });
  return provider.chatModel(model);
}

export type AgenticAnswerOptions = {
  instructions: string;
  input: string;
  tools: GatewayToolDef[];
  execute: GatewayToolExecutor;
  temperature?: number;
  maxTokens?: number;
  /** Agentic tool round-trips; the bot uses a single round-trip (v1). */
  maxSteps?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Agentic answer over the allow-listed tools: the model may call tools, the
 * SDK feeds results back automatically (bounded by maxSteps), and we return
 * the final text.
 */
export async function agenticAnswer(
  baseUrl: string,
  apiKey: string,
  model: string,
  options: AgenticAnswerOptions
): Promise<string> {
  const {
    instructions,
    input,
    tools,
    execute,
    temperature = 70,
    maxTokens,
    maxSteps = 2,
    fetchImpl = fetch
  } = options;
  // streamText: the gateway (Bifrost/KiosAPI) only answers streaming
  // reliably, so we stream SSE and resolve the assembled text. Tools run
  // automatically, bounded by maxSteps.
  const result = streamText({
    model: createGatewayModel(baseUrl, apiKey, model, fetchImpl),
    system: instructions,
    prompt: input,
    tools: toSdkTools(tools, execute),
    stopWhen: stepCountIs(maxSteps),
    temperature: temperature / 100,
    ...(maxTokens !== undefined ? { maxTokens } : {})
  });
  const text = await result.text;
  return text || "ขออภัย ไม่สามารถหาคำตอบได้";
}

export type PlainChatOptions = {
  temperature?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
};

/** Plain non-agentic chat (backoffice playground). */
export async function plainChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  instructions: string,
  input: string,
  options: PlainChatOptions = {}
): Promise<string> {
  const { temperature = 70, maxTokens, fetchImpl = fetch } = options;
  const result = streamText({
    model: createGatewayModel(baseUrl, apiKey, model, fetchImpl),
    system: instructions,
    prompt: input,
    temperature: temperature / 100,
    ...(maxTokens !== undefined ? { maxTokens } : {})
  });
  const text = await result.text;
  return text || "(no reply)";
}
