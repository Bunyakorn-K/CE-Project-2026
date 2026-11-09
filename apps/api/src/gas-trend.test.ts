import { describe, expect, it } from "vitest";
import {
  GAS_CHANNELS,
  GAS_TREND_THRESHOLDS,
  evaluateGasTrend,
  gasAlertFromDecision,
  type GasSample,
  type GasTrendContext
} from "./gas-trend";

// The window every fixture is built around. Fixed, so a test never depends on
// when it runs — and so the evidence strings are stable enough to assert on.
const WINDOW_TO = new Date("2026-11-09T06:00:00.000Z");
const WINDOW_FROM = new Date("2026-11-09T00:00:00.000Z"); // 6 h
const CHANNEL = "gas_run_a_pressure" as const;

function samplesAt(
  channel: string,
  values: Array<number | null>,
  stepMinutes: number,
  end: Date = WINDOW_TO
): GasSample[] {
  return values.map((valuePsi, index) => ({
    channel,
    recordedAt: new Date(end.getTime() - (values.length - 1 - index) * stepMinutes * 60000),
    valuePsi
  }));
}

function context(over: Partial<GasTrendContext> = {}): GasTrendContext {
  return {
    channel: CHANNEL,
    window: { from: WINDOW_FROM, to: WINDOW_TO },
    machineState: "running",
    temperatureC: 62.5,
    branchOpenState: "open",
    ...over
  };
}

// 17 samples over 4 h: 15-minute cadence, so 4 h of span and enough points.
const declineValues = Array.from({ length: 17 }, (_, index) => 60 - index * 0.5); // -2 psi/h
const steadyValues = Array.from({ length: 17 }, (_, index) => 50 + (index % 2 === 0 ? 0.1 : -0.1));
const risingValues = Array.from({ length: 17 }, (_, index) => 44 + index * 0.5); // +2 psi/h

describe("evaluateGasTrend", () => {
  it("answers unknown when the channel has no samples at all", () => {
    const decision = evaluateGasTrend([], context());
    expect(decision.trend).toBe("unknown");
    expect(decision.evidence.reason).toBe("no_samples_in_window");
    expect(decision.evidence.sampleCount).toBe(0);
  });

  it("answers unknown for an all-NULL window rather than a trend", () => {
    const samples = samplesAt(CHANNEL, Array.from({ length: 17 }, () => null), 15);
    const decision = evaluateGasTrend(samples, context());
    expect(decision.trend).toBe("unknown");
    expect(decision.evidence.nonNullCount).toBe(0);
    expect(decision.evidence.coveragePct).toBe(0);
    expect(decision.evidence.reason).toContain("coverage_below_minimum");
  });

  it("answers unknown at 50 % coverage, the plan's stated case", () => {
    const values = declineValues.slice(0, 16).map((value, index) => (index % 2 === 0 ? value : null));
    const decision = evaluateGasTrend(samplesAt(CHANNEL, values, 15), context());
    expect(decision.evidence.coveragePct).toBe(50);
    expect(decision.trend).toBe("unknown");
    expect(decision.evidence.reason).toContain("coverage_below_minimum");
  });

  it("counts NULL rows as minutes, not as 0 psi", () => {
    const values = declineValues.map((value, index) => (index < 3 ? null : value));
    const decision = evaluateGasTrend(samplesAt(CHANNEL, values, 15), context());
    // Three NULL rows at a 15-minute cadence are 45 minutes of "no value".
    expect(decision.evidence.nullMinutes).toBe(45);
    expect(decision.evidence.coveragePct).toBeGreaterThan(GAS_TREND_THRESHOLDS.minCoveragePct);
  });

  it("declares declining for a monotone 4 h decline with the machine running", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, declineValues, 15), context());
    expect(decision.trend).toBe("declining");
    expect(decision.alertable).toBe(true);
    expect(decision.suppression).toBeNull();
    expect(decision.evidence.slopePsiPerHour).toBeLessThan(0);
    expect(decision.evidence.firstEdgePsi).toBeGreaterThan(decision.evidence.lastEdgePsi ?? 0);
  });

  it("declares steady for a flat series", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, steadyValues, 15), context());
    expect(decision.trend).toBe("steady");
    expect(decision.alertable).toBe(false);
  });

  it("never calls a rise declining, and keeps the slope in evidence", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, risingValues, 15), context());
    expect(decision.trend).toBe("steady");
    expect(decision.evidence.slopePsiPerHour).toBeGreaterThan(0);
    expect(decision.alertable).toBe(false);
  });

  it("does not turn a single dip into a trend", () => {
    const values = steadyValues.map((value, index) => (index === 8 ? value - 6 : value));
    const decision = evaluateGasTrend(samplesAt(CHANNEL, values, 15), context());
    expect(decision.trend).not.toBe("declining");
    expect(decision.alertable).toBe(false);
  });

  it("does not turn a single edge outlier into a decline, which is what the edge medians are for", () => {
    // One spurious high reading at the very start: comparing raw endpoints
    // would see an 8 psi drop, and the least-squares slope alone would clear
    // the decline threshold. The median of the first three values absorbs it.
    const values = steadyValues.map((value, index) => (index === 0 ? value + 8 : value));
    const decision = evaluateGasTrend(samplesAt(CHANNEL, values, 15), context());
    expect(decision.evidence.slopePsiPerHour).toBeLessThan(0);
    expect(decision.evidence.firstEdgePsi).toBeGreaterThan(49);
    expect(decision.evidence.firstEdgePsi).toBeLessThan(52);
    expect(decision.trend).toBe("steady");
  });

  it("declares declining when both edges agree even if the interior is noisy", () => {
    // Recorded from production 2026-11-09 02:26 -> 07:44 UTC,
    // laundrytwin_analytics.fact_gas_pressure_sample, gas_run_a_pressure: every
    // 6th of 261 samples, with the real (irregular) sample offsets in minutes so
    // the fixture reproduces the actual series rather than an even one.
    //
    // This is the case that decided the gate. The fitted slope is -0.298 psi/h,
    // which a slope-gated verdict reads as `steady`; both edge medians say
    // 78 -> 66 psi over 5.3 h, i.e. -2.27 psi/h. The tank really did lose 12 psi.
    const offsetsMinutes = [
      0, 3.6, 7.1, 10.3, 12.7, 16.3, 19.2, 22.4, 26.5, 29.1, 31.2, 38.3, 49.2, 54, 60.4, 65.3,
      69.3, 72, 74.4, 78.8, 87, 98.2, 112.3, 120.1, 127.1, 131.5, 138.9, 149.7, 152.9, 159, 165.1,
      169.5, 188.6, 205.8, 215.4, 256.7, 268, 276.3, 288.4, 292, 306.8, 311.6, 316.1, 317.5
    ];
    const values = [
      80, 78, 72, 68, 70, 70, 71, 69, 69, 67, 72, 68, 66, 66, 66, 64, 64, 64, 64, 63, 63, 65, 63,
      63, 63, 65, 66, 64, 66, 66, 66, 66, 68, 68, 70, 76, 70, 68, 68, 70, 70, 66, 62, 68
    ];
    const samples: GasSample[] = values.map((valuePsi, index) => ({
      channel: CHANNEL,
      recordedAt: new Date(WINDOW_TO.getTime() - (offsetsMinutes[offsetsMinutes.length - 1] - offsetsMinutes[index]) * 60000),
      valuePsi
    }));
    const decision = evaluateGasTrend(samples, context());
    expect(decision.evidence.slopePsiPerHour).toBeGreaterThan(-GAS_TREND_THRESHOLDS.declinePsiPerHour);
    expect(decision.evidence.edgeRatePsiPerHour).toBeLessThan(-GAS_TREND_THRESHOLDS.declinePsiPerHour);
    expect(decision.trend).toBe("declining");
  });

  it("withholds the alert when the branch positively says it is shut", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, declineValues, 15), context({ branchOpenState: "closed" }));
    expect(decision.trend).toBe("declining");
    expect(decision.alertable).toBe(false);
    expect(decision.suppression).toBe("branch_closed");
  });

  it("does not suppress on an unknown schedule — unknown is not closed", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, declineValues, 15), context({ branchOpenState: "unknown" }));
    expect(decision.alertable).toBe(true);
    expect(decision.suppression).toBeNull();
  });

  it("answers unknown when machine state could not be measured", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, declineValues, 15), context({ machineState: "unknown" }));
    expect(decision.trend).toBe("unknown");
    expect(decision.suppression).toBe("machine_state_unknown");
    expect(decision.evidence.reason).toBe("machine_state_unknown");
  });

  it("answers unknown when temperature is missing, per R06", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, declineValues, 15), context({ temperatureC: null }));
    expect(decision.trend).toBe("unknown");
    expect(decision.suppression).toBe("temperature_unknown");
  });

  it("answers unknown for a window shorter than three hours", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, declineValues, 5), context());
    expect(decision.trend).toBe("unknown");
    expect(decision.evidence.reason).toContain("span_too_short");
  });

  it("answers unknown when there are fewer than the minimum number of values", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, declineValues.slice(0, 6), 60), context());
    expect(decision.trend).toBe("unknown");
    expect(decision.evidence.reason).toContain("too_few_samples");
  });

  it("ignores samples from another channel", () => {
    const other = samplesAt("gas_run_b_pressure", declineValues, 15);
    const decision = evaluateGasTrend(other, context());
    expect(decision.trend).toBe("unknown");
    expect(decision.evidence.sampleCount).toBe(0);
  });

  it("ignores samples outside the window", () => {
    const outside = samplesAt(CHANNEL, declineValues, 15, new Date("2026-11-08T06:00:00.000Z"));
    const decision = evaluateGasTrend(outside, context());
    expect(decision.evidence.sampleCount).toBe(0);
  });

  it("refuses to evaluate a gas_detector entity, which is a heartbeat, not a measurement", () => {
    const samples = samplesAt("gas_detector_a", declineValues, 15);
    const decision = evaluateGasTrend(samples, { ...context(), channel: "gas_detector_a" as never });
    expect(decision.trend).toBe("unknown");
    expect(decision.evidence.channel).toBeNull();
    expect(decision.evidence.reason).toContain("channel_not_evaluable");
    expect(gasAlertFromDecision(decision, { branchId: "b1", windowEnd: WINDOW_TO })).toBeNull();
  });

  it("names its threshold version and carries the thresholds it applied", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, declineValues, 15), context());
    expect(decision.evidence.thresholdVersion).toBe(GAS_TREND_THRESHOLDS.version);
    expect(decision.evidence.thresholds).toEqual(GAS_TREND_THRESHOLDS);
  });

  it("carries the window, the observed context and the counts in evidence", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, declineValues, 15), context());
    expect(decision.evidence.window).toEqual({ from: WINDOW_FROM.toISOString(), to: WINDOW_TO.toISOString() });
    expect(decision.evidence.machineState).toBe("running");
    expect(decision.evidence.temperatureC).toBe(62.5);
    expect(decision.evidence.branchOpenState).toBe("open");
    expect(decision.evidence.sampleCount).toBe(17);
    expect(decision.evidence.spanMinutes).toBe(240);
  });

  it("treats a NaN value as missing rather than as a number", () => {
    const values = declineValues.map((value, index) => (index === 4 ? Number.NaN : value));
    const decision = evaluateGasTrend(samplesAt(CHANNEL, values, 15), context());
    expect(decision.evidence.nonNullCount).toBe(16);
  });

  it("is pure — the same input twice gives the same verdict", () => {
    const samples = samplesAt(CHANNEL, declineValues, 15);
    expect(evaluateGasTrend(samples, context())).toEqual(evaluateGasTrend(samples, context()));
  });

  it("evaluates all three contract channels", () => {
    for (const channel of GAS_CHANNELS) {
      const decision = evaluateGasTrend(samplesAt(channel, declineValues, 15), { ...context(), channel });
      expect(decision.evidence.channel).toBe(channel);
      expect(decision.trend).toBe("declining");
    }
  });
});

describe("gasAlertFromDecision", () => {
  it("produces a declining alert with a gas. ruleId", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, declineValues, 15), context());
    const alert = gasAlertFromDecision(decision, { branchId: "branch-01", windowEnd: WINDOW_TO });
    expect(alert).not.toBeNull();
    expect(alert?.ruleId).toBe(`gas.${CHANNEL}.declining`);
    expect(alert?.ruleVersion).toBe(GAS_TREND_THRESHOLDS.version);
    expect(alert?.branchId).toBe("branch-01");
    expect(alert?.severity).toBe("warning");
  });

  it("refuses to build an alert from a non-declining verdict", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, steadyValues, 15), context());
    expect(gasAlertFromDecision(decision, { branchId: "b1", windowEnd: WINDOW_TO })).toBeNull();
  });

  it("refuses to build an alert from a suppressed decline", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, declineValues, 15), context({ branchOpenState: "closed" }));
    expect(gasAlertFromDecision(decision, { branchId: "b1", windowEnd: WINDOW_TO })).toBeNull();
  });

  it("buckets its id by the hour so two sweeps in one hour are one claim", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, declineValues, 15), context());
    const first = gasAlertFromDecision(decision, { branchId: "b1", windowEnd: new Date("2026-11-09T06:05:00Z") });
    const sameHour = gasAlertFromDecision(decision, { branchId: "b1", windowEnd: new Date("2026-11-09T06:55:00Z") });
    const nextHour = gasAlertFromDecision(decision, { branchId: "b1", windowEnd: new Date("2026-11-09T07:00:00Z") });
    expect(first?.id).toBe(sameHour?.id);
    expect(first?.id).not.toBe(nextHour?.id);
  });

  it("never phrases the finding as a leak", () => {
    const decision = evaluateGasTrend(samplesAt(CHANNEL, declineValues, 15), context());
    const alert = gasAlertFromDecision(decision, { branchId: "b1", windowEnd: WINDOW_TO });
    expect(alert?.title).not.toContain("รั่ว");
    // The message says what it is NOT, in the same sentence, so a reader who
    // skims the title still cannot walk away with a safety claim.
    expect(alert?.detail).toContain("ไม่ใช่การตรวจจับแก๊สรั่ว");
  });
});
