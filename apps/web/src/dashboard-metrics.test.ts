import { describe, expect, it } from "vitest";
import { summarizeMachineActivity } from "./dashboard-metrics";

describe("machine activity summary", () => {
  it("keeps unavailable telemetry separate from observed running and ready states", () => {
    const summary = summarizeMachineActivity([
      { state: "washing", freshness: "fresh" },
      { state: "ready", freshness: "fresh" },
      { state: null, freshness: "unavailable" }
    ]);

    expect(summary).toEqual({ running: 1, ready: 1, unavailable: 1 });
  });
});
