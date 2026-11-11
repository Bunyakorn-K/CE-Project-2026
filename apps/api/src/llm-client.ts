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
  args: Record<string, unknown>,
  meta?: { toolCallId?: string }
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
      execute: async (input: unknown, options?: { toolCallId?: string }) => {
        const args =
          input && typeof input === "object" ? (input as Record<string, unknown>) : {};
        const result = await execute(def.name, args, { toolCallId: options?.toolCallId });
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

export type PriorMessage = { role: "user" | "assistant"; content: string };

export type AgenticAnswerOptions = {
  instructions: string;
  input: string;
  /**
   * Earlier turns, oldest first. Sent as chat messages rather than folded into the
   * prompt: the model needs to see the alternation to resolve "and yesterday?", and
   * a transcript pasted into one user message reads as a document to summarise.
   */
  messages?: PriorMessage[];
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
export type AgenticAnswerResult = {
  text: string;
  /** How many model turns ran, including the one that produced the answer. */
  steps: number;
  toolCalls: number;
  /** The tool names the model actually called — what a test console shows. */
  toolNames: string[];
  /** Prompt tokens for the whole loop; 0 when the gateway does not report them. */
  inputTokens: number;
  outputTokens: number;
};

export async function agenticAnswerWithMeta(
  baseUrl: string,
  apiKey: string,
  model: string,
  options: AgenticAnswerOptions
): Promise<AgenticAnswerResult> {
  const {
    instructions,
    input,
    messages,
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
    // The SDK takes messages OR a prompt; with history the current question is the
    // last message so the alternation stays valid.
    ...(messages?.length
      ? { messages: [...messages, { role: "user" as const, content: input }] }
      : { prompt: input }),
    tools: toSdkTools(tools, execute),
    stopWhen: stepCountIs(maxSteps),
    temperature: temperature / 100,
    ...(maxTokens !== undefined ? { maxTokens } : {})
  });
  const [text, steps, usage] = await Promise.all([result.text, result.steps, result.totalUsage]);
  const calls = steps.flatMap((step) => step.toolCalls ?? []);
  return {
    text: text || "ขออภัย ไม่สามารถหาคำตอบได้",
    steps: steps.length,
    toolCalls: calls.length,
    toolNames: calls.map((call) => call.toolName),
    // Tokens are the only way a latency becomes a cost. The gateway may omit them,
    // so they are optional rather than invented.
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0
  };
}

/** Text only, for callers that do not record how the answer was produced. */
export async function agenticAnswer(
  baseUrl: string,
  apiKey: string,
  model: string,
  options: AgenticAnswerOptions
): Promise<string> {
  return (await agenticAnswerWithMeta(baseUrl, apiKey, model, options)).text;
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
