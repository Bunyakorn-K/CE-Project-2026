import { describe, expect, it } from "vitest";
import { initTelemetry, telemetryStatus, withAnswerSpan } from "./telemetry";

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
