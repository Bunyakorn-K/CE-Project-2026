import { describe, expect, it } from "vitest";
import { db, initializeDatabase } from "./db";
import { aiTrace } from "./schema";
import { hashUser, initTelemetry, telemetryStatus, withAnswerSpan, withToolSpan } from "./telemetry";

initializeDatabase();

describe("telemetryStatus", () => {
  it("is off, and says why, when no endpoint is configured", () => {
    const status = telemetryStatus({});
    expect(status.enabled).toBe(false);
    expect(status.endpoint).toBeNull();
    expect(status.reason).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(status.recordsContent).toBe(false);
  });

  it("is on when an endpoint is set, and keeps content out by default", () => {
    const status = telemetryStatus({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" });
    expect(status.enabled).toBe(true);
    expect(status.endpoint).toBe("http://collector:4318");
    // The question and the answer stay local unless someone says otherwise.
    expect(status.recordsContent).toBe(false);
  });

  it("records content only when explicitly asked", () => {
    expect(telemetryStatus({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_RECORD_CONTENT: "1" }).recordsContent).toBe(true);
    expect(telemetryStatus({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_RECORD_CONTENT: "0" }).recordsContent).toBe(false);
  });
});

describe("initTelemetry", () => {
  it("does nothing without an endpoint", async () => {
    const status = await initTelemetry({});
    expect(status.enabled).toBe(false);
  });
});

describe("withAnswerSpan", () => {
  const attributes = {
    model: "test-model",
    steps: 2,
    toolCalls: 3,
    promptVersion: "v-test",
    roleLabel: "owner",
    question: "ภาพรวมวันนี้"
  };

  it("returns the answer untouched when tracing is off", async () => {
    await expect(withAnswerSpan(attributes, async () => "ตอบแล้ว", {})).resolves.toBe("ตอบแล้ว");
  });

  it("lets a failure through rather than swallowing it", async () => {
    await expect(
      withAnswerSpan(attributes, async () => {
        throw new Error("gateway down");
      }, {})
    ).rejects.toThrow("gateway down");
  });
});

describe("local trace rows", () => {
  const attributes = {
    model: "test-model",
    steps: 0,
    toolCalls: 0,
    promptVersion: "v-test",
    roleLabel: "owner",
    turnId: "turn-1",
    finalize: (result: unknown) => ({
      "llm.steps": (result as { steps: number }).steps,
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.request.model": "agnes-2.5-flash"
    })
  };

  it("keeps one row per answer, with the numbers known only at the end", async () => {
    db.delete(aiTrace).run();
    await withAnswerSpan(attributes, async () => ({ steps: 3 }), {});
    const rows = db.select().from(aiTrace).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("chat.answer");
    expect(rows[0].turnId).toBe("turn-1");
    expect(rows[0].status).toBe("ok");
    const parsed = JSON.parse(rows[0].attributes) as Record<string, unknown>;
    expect(parsed["llm.steps"]).toBe(3);
    expect(parsed["gen_ai.usage.input_tokens"]).toBe(120);
    // The model is replaced by the one that actually answered, not the placeholder.
    expect(parsed["gen_ai.request.model"]).toBe("agnes-2.5-flash");
    // Never the question or the answer.
    expect(JSON.stringify(parsed)).not.toContain("ภาพรวมวันนี้");
  });

  it("records a failure as a failure", async () => {
    db.delete(aiTrace).run();
    await expect(
      withAnswerSpan(attributes, async () => {
        throw new Error("gateway down");
      }, {})
    ).rejects.toThrow("gateway down");
    const rows = db.select().from(aiTrace).all();
    expect(rows[0].status).toBe("error");
    expect(rows[0].attributes).toContain("gateway down");
  });

  it("gives every tool call its own row, under the turn", async () => {
    db.delete(aiTrace).run();
    await withToolSpan("get_revenue", "turn-9", async () => "x".repeat(42));
    const rows = db.select().from(aiTrace).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("tool.get_revenue");
    expect(rows[0].turnId).toBe("turn-9");
    const attributes = JSON.parse(rows[0].attributes) as Record<string, unknown>;
    expect(attributes["tool.result_chars"]).toBe(42);
    // The GenAI convention is what a collector reads to label a tool span.
    expect(attributes["gen_ai.tool.name"]).toBe("get_revenue");
    expect(attributes["gen_ai.operation.name"]).toBe("execute_tool");
  });

  it("records a failed tool call without throwing away the error", async () => {
    db.delete(aiTrace).run();
    await expect(withToolSpan("get_revenue", "turn-9", async () => {
      throw new Error("MCP 503");
    })).rejects.toThrow("MCP 503");
    expect(db.select().from(aiTrace).all()[0].status).toBe("error");
  });
});

describe("session pseudonym", () => {
  it("is stable, and not the LINE id", () => {
    const first = hashUser("U284d77fa27c1bf0be58fe91ad71618d3", {});
    expect(first).toBe(hashUser("U284d77fa27c1bf0be58fe91ad71618d3", {}));
    expect(first).not.toContain("U284d");
    expect(first).toHaveLength(16);
    // A different salt gives a different pseudonym.
    expect(hashUser("U284d77fa27c1bf0be58fe91ad71618d3", { OTEL_HASH_SALT: "x" })).not.toBe(first);
  });
});
