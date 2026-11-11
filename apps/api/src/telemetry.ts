/**
 * Tracing, if someone asks for it.
 *
 * WHY OPT-IN AND OFF. A trace of an answer contains the question, the branch names,
 * the tool arguments and the reply — the shop's data. Sending that to a collector is
 * a decision the owner makes, not a default a deploy makes. With no
 * `OTEL_EXPORTER_OTLP_ENDPOINT` this module does nothing at all: no SDK started, no
 * exporter, no import of the OpenTelemetry packages.
 *
 * WHAT LEAVES THE BOX. When enabled, spans carry the shape of the work — model, number
 * of steps, tool names, latency, token counts, errors — and NOT the text:
 * `recordInputs`/`recordOutputs` are false unless `OTEL_RECORD_CONTENT=1` says
 * otherwise. That is the difference between "which answers are slow" and "here is
 * everything the shop asked", and the first is what an operator needs first.
 *
 * WHY OTLP AND NOT A VENDOR SDK. OpenTelemetry is the wire format Langfuse, Phoenix,
 * Grafana Tempo and Jaeger all accept, so the collector can be swapped by changing an
 * environment variable instead of the code.
 */

import { createHash, randomUUID } from "node:crypto";
import { db } from "./db";
import { aiTrace } from "./schema";

export type TelemetryStatus = {
  enabled: boolean;
  endpoint: string | null;
  serviceName: string;
  /** True when prompt and completion text is exported. */
  recordsContent: boolean;
  reason?: string;
};

const SERVICE_NAME = "laundrytwin-api";

export function telemetryStatus(env: NodeJS.ProcessEnv = process.env): TelemetryStatus {
  const endpoint = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim();
  return {
    enabled: endpoint.length > 0,
    endpoint: endpoint || null,
    serviceName: (env.OTEL_SERVICE_NAME ?? SERVICE_NAME).trim() || SERVICE_NAME,
    recordsContent: (env.OTEL_RECORD_CONTENT ?? "0").trim() === "1",
    reason: endpoint.length > 0 ? undefined : "OTEL_EXPORTER_OTLP_ENDPOINT is not set"
  };
}

let started = false;

/**
 * Start the SDK and register the AI SDK integration. Idempotent, and never throws:
 * tracing must not be able to stop the API from serving a request.
 */
export async function initTelemetry(env: NodeJS.ProcessEnv = process.env): Promise<TelemetryStatus> {
  const status = telemetryStatus(env);
  if (!status.enabled || started) return status;
  started = true;

  try {
    const [{ NodeSDK }, { OTLPTraceExporter }, { resourceFromAttributes }, { ATTR_SERVICE_NAME }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions")
    ]);

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: status.serviceName }),
      traceExporter: new OTLPTraceExporter()
    });
    sdk.start();
    // Spans are ours, not the SDK's: `withAnswerSpan` records the shape of the work
    // (model, steps, tool count, latency, prompt version) and never the text. The AI
    // SDK's own telemetry would record prompts and completions, which is precisely
    // what this deployment must not ship to a collector by accident.

    const shutdown = () => {
      void sdk.shutdown().catch(() => undefined);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    console.log(`[telemetry] OTLP export enabled -> ${status.endpoint} (content: ${status.recordsContent ? "on" : "off"})`);
  } catch (error) {
    // A missing package or a bad endpoint is logged, not fatal: the answer is more
    // important than the trace of it.
    console.error(
      `[telemetry] requested but could not start: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return status;
}

/**
 * A stable pseudonym for a LINE user, so spans can be grouped by person without
 * putting the LINE id in a collector. Salted with `OTEL_HASH_SALT` when set.
 */
export function hashUser(lineUserId: string, env: NodeJS.ProcessEnv = process.env): string {
  const salt = (env.OTEL_HASH_SALT ?? "laundrytwin").trim();
  return createHash("sha256").update(`${salt}:${lineUserId}`).digest("hex").slice(0, 16);
}

/** One span, kept locally. Metadata only — the text lives in `chat_turn`. */
function persistTrace(input: {
  turnId: string | null;
  name: string;
  status: "ok" | "error";
  durationMs: number;
  attributes: Record<string, unknown>;
}): void {
  try {
    db.insert(aiTrace)
      .values({
        id: randomUUID(),
        turnId: input.turnId,
        name: input.name,
        status: input.status,
        durationMs: Math.round(input.durationMs),
        attributes: JSON.stringify(input.attributes),
        createdAt: new Date()
      })
      .run();
  } catch {
    // A trace row must never be the reason an answer fails.
  }
}

export type AnswerSpanAttributes = {
  model: string;
  steps: number;
  toolCalls: number;
  promptVersion: string;
  roleLabel: string;
  /** Only when `OTEL_RECORD_CONTENT=1`; otherwise the text stays local. */
  question?: string;
  /** Groups every span of one answer. */
  turnId?: string;
  /** Pseudonym for the LINE user, so a collector can group sessions. */
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Attributes known only after the work is done (steps, tool count, tokens). The
   * span is opened before the call so a hung model is visible, and completed with
   * these on the way out — a span that reports "0 steps" for every answer is worse
   * than no span at all.
   */
  finalize?: (result: unknown) => Record<string, unknown>;
};

/**
 * Run `fn` inside a span named `chat.answer`.
 *
 * `@opentelemetry/api` is a no-op tracer until an SDK is started, so calling this when
 * tracing is off costs a function call and nothing else — which is why the call sites
 * do not need to ask whether tracing is on.
 */
export async function withAnswerSpan<T>(
  attributes: AnswerSpanAttributes,
  fn: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env
): Promise<T> {
  const { trace, SpanStatusCode } = await import("@opentelemetry/api");
  const tracer = trace.getTracer("laundrytwin");
  const recordsContent = telemetryStatus(env).recordsContent;

  const turnId = attributes.turnId ?? randomUUID();
  const startedAt = Date.now();
  const metadata: Record<string, unknown> = {
    "llm.model": attributes.model,
    "llm.steps": attributes.steps,
    "llm.tool_calls": attributes.toolCalls,
    "llm.prompt_version": attributes.promptVersion,
    "chat.role": attributes.roleLabel,
    ...(attributes.sessionId ? { "session.id": attributes.sessionId } : {}),
    ...(attributes.inputTokens !== undefined ? { "llm.input_tokens": attributes.inputTokens } : {}),
    ...(attributes.outputTokens !== undefined ? { "llm.output_tokens": attributes.outputTokens } : {})
  };

  return tracer.startActiveSpan("chat.answer", async (span) => {
    span.setAttributes(metadata as Record<string, string | number>);
    if (recordsContent && attributes.question) span.setAttribute("chat.question", attributes.question);
    try {
      const result = await fn();
      const final = attributes.finalize ? attributes.finalize(result) : {};
      span.setAttributes(final as Record<string, string | number>);
      persistTrace({
        turnId,
        name: "chat.answer",
        status: "ok",
        durationMs: Date.now() - startedAt,
        attributes: { ...metadata, ...final }
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      persistTrace({
        turnId,
        name: "chat.answer",
        status: "error",
        durationMs: Date.now() - startedAt,
        attributes: { ...metadata, error: message.slice(0, 200) }
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * A tool call, as its own span.
 *
 * The answer span says 89 seconds; this says which of the four calls spent them. It is
 * the reason L1 exists at all — `chat_turn` records the total and nothing else.
 */
export async function withToolSpan<T>(
  tool: string,
  turnId: string | null,
  fn: () => Promise<T>
): Promise<T> {
  const { trace, SpanStatusCode } = await import("@opentelemetry/api");
  const startedAt = Date.now();
  const metadata = { "tool.name": tool, ...(turnId ? { "turn.id": turnId } : {}) };

  return trace.getTracer("laundrytwin").startActiveSpan(`tool.${tool}`, async (span) => {
    span.setAttributes(metadata);
    try {
      const result = await fn();
      const text = typeof result === "string" ? result.length : 0;
      persistTrace({ turnId, name: `tool.${tool}`, status: "ok", durationMs: Date.now() - startedAt, attributes: { ...metadata, "tool.result_chars": text } });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      persistTrace({
        turnId,
        name: `tool.${tool}`,
        status: "error",
        durationMs: Date.now() - startedAt,
        attributes: { ...metadata, error: message.slice(0, 200) }
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
