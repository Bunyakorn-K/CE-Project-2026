/**
 * Gas-pressure trend evaluation (R06), as a pure decision.
 *
 * WHAT THIS IS. A judgement about the shape of one pressure channel over one
 * bounded window, carrying every number it was derived from. It is the only
 * place in this repository that decides whether tank pressure is "declining",
 * so the thresholds, the NULL handling and the suppression rules live here
 * rather than in the caller (the alert sweep).
 *
 * WHAT THIS IS NOT. It is **not** a leak detector and it is **not** a safety
 * system. A falling psi reading has several benign explanations — normal
 * consumption, ambient temperature, regulator behaviour, sensor dropout — and
 * `docs/03_data_contracts/ha_gas_sensor_contract.md` keeps `gas_leak_detected`
 * a separate field sourced from a dedicated physical detector. No caller may
 * turn a `declining` verdict here into leak language.
 *
 * THE THREE RULES THAT MAKE A CLAIM DEFENSIBLE:
 *
 *  1. NULL is not 0. `value_psi` is `Nullable(Float32)` and Home Assistant's
 *     `unavailable` is stored as NULL (the observed minimum is 9 psi, so a
 *     coerced 0 would read as an empty tank). A window that is mostly NULL
 *     answers `unknown`, never a trend.
 *  2. A trend needs machine state AND temperature. R06 says a pressure reading
 *     supports a low-gas estimate only *when evaluated with* both; a decline
 *     observed while nothing is running, or with no temperature, is not
 *     attributable to consumption. Missing context ⇒ `unknown`.
 *  3. One dip is not a trend. The verdict compares the median of the first
 *     three samples against the median of the last three over at least three
 *     hours, so a single dropout-shaped dip cannot clear the drop threshold.
 *
 * `gas_detector_*` entities are excluded by contract: they are a liveness
 * heartbeat (a 50.00–50.03 % daily ratio on a fixed 5–25 s cadence), not a
 * concentration measurement. The channel type below is an allow-list, so an
 * entity that is not one of the three pressure channels cannot be evaluated at
 * all — the exclusion is structural, not a filter someone can delete.
 */

export const GAS_CHANNELS = [
  "gas_run_a_pressure",
  "gas_run_b_pressure",
  "changeover_filter_pressure"
] as const;

export type GasChannel = (typeof GAS_CHANNELS)[number];

export type GasTrendName = "unknown" | "steady" | "declining";

export type BranchOpenStateLike = "open" | "closed" | "unknown";

export type MachineStateLike = "running" | "idle" | "unknown";

/** One stored row of `fact_gas_pressure_sample`, as the reader returns it. */
export type GasSample = {
  channel: string;
  recordedAt: Date;
  valuePsi: number | null;
};

export type GasTrendContext = {
  channel: GasChannel;
  window: { from: Date; to: Date };
  /**
   * Machine state observed over the same window. `unknown` means the caller
   * could not measure it, which is a different fact from `idle`.
   */
  machineState: MachineStateLike;
  /** Mean/representative wash-phase temperature over the window, Celsius. */
  temperatureC: number | null;
  /** Resolved from `dim_branch_hours` by the report path, never guessed. */
  branchOpenState: BranchOpenStateLike;
};

export type GasTrendEvidence = {
  channel: GasChannel | null;
  window: { from: string; to: string };
  sampleCount: number;
  nonNullCount: number;
  /** Non-null rows as a percentage of the rows actually reported. */
  coveragePct: number;
  /** Minutes inside the window that reported NULL (no value), never 0 psi. */
  nullMinutes: number;
  spanMinutes: number;
  /** Median of the first / last `edgeSamples` non-null values, psi. */
  firstEdgePsi: number | null;
  lastEdgePsi: number | null;
  /** Least-squares slope over all non-null samples, psi per hour. */
  slopePsiPerHour: number | null;
  /**
   * The rate the verdict is actually gated on: edge-median change per hour.
   * Kept beside the fitted slope because on real, oscillating data the two
   * disagree and the reader deserves both.
   */
  edgeRatePsiPerHour: number | null;
  machineState: MachineStateLike;
  temperatureC: number | null;
  branchOpenState: BranchOpenStateLike;
  thresholdVersion: string;
  thresholds: typeof GAS_TREND_THRESHOLDS;
  reason: string;
};

export type GasTrendDecision = {
  trend: GasTrendName;
  /**
   * False when a declining shape is real but must not be reported: a branch
   * that positively says it is shut has idle machines, and "pressure fell
   * while nothing ran" is not a finding about gas.
   */
  alertable: boolean;
  suppression: "branch_closed" | "machine_state_unknown" | "temperature_unknown" | null;
  evidence: GasTrendEvidence;
};

/**
 * Thresholds, exported and versioned so a verdict can say which rule set
 * produced it and so the caller never carries a magic number.
 *
 * `declinePsiPerHour` and `minDropPsi` are deliberately conservative: they
 * describe a sustained decline worth a human look, not a tight bound. There is
 * no calibrated "low gas" psi threshold for this site — the contract records
 * the observed minimum (9 psi) and nothing about tank capacity — so nothing
 * here claims to know at what pressure the tank is nearly empty.
 */
export const GAS_TREND_THRESHOLDS = {
  version: "2026-11-09.1",
  /** Below this share of non-null rows the window cannot speak. */
  minCoveragePct: 80,
  /** A trend needs at least three hours of history. */
  minSpanMinutes: 180,
  /** And enough points that one of them cannot be the whole story. */
  minSamples: 12,
  /** Slope at or below this (psi/hour) counts as declining. */
  declinePsiPerHour: 0.5,
  /** Edge-to-edge drop that must also be present, psi. */
  minDropPsi: 1,
  /** How many samples each edge median is taken over. */
  edgeSamples: 3,
  /** Assumed spacing used to turn NULL rows into minutes, when unknown. */
  fallbackSpacingMinutes: 60
} as const;

function isGasChannel(channel: string): channel is GasChannel {
  return (GAS_CHANNELS as readonly string[]).includes(channel);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60000;
}

/** Least-squares slope of value against time, in psi per hour. */
function slopePerHour(points: Array<{ at: number; value: number }>): number | null {
  if (points.length < 2) return null;
  const t0 = points[0].at;
  const xs = points.map((point) => (point.at - t0) / 3600000); // hours
  const ys = points.map((point) => point.value);
  const n = xs.length;
  const meanX = xs.reduce((sum, x) => sum + x, 0) / n;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (xs[index] - meanX) * (ys[index] - meanY);
    denominator += (xs[index] - meanX) ** 2;
  }
  if (denominator === 0) return null;
  return numerator / denominator;
}

function unknownDecision(
  evidence: Partial<GasTrendEvidence> & { channel: GasChannel | null },
  reason: string,
  suppression: GasTrendDecision["suppression"] = null
): GasTrendDecision {
  return {
    trend: "unknown",
    alertable: false,
    suppression,
    evidence: {
      channel: evidence.channel,
      window: evidence.window ?? { from: "", to: "" },
      sampleCount: evidence.sampleCount ?? 0,
      nonNullCount: evidence.nonNullCount ?? 0,
      coveragePct: evidence.coveragePct ?? 0,
      nullMinutes: evidence.nullMinutes ?? 0,
      spanMinutes: evidence.spanMinutes ?? 0,
      firstEdgePsi: evidence.firstEdgePsi ?? null,
      lastEdgePsi: evidence.lastEdgePsi ?? null,
      slopePsiPerHour: evidence.slopePsiPerHour ?? null,
      edgeRatePsiPerHour: evidence.edgeRatePsiPerHour ?? null,
      machineState: evidence.machineState ?? "unknown",
      temperatureC: evidence.temperatureC ?? null,
      branchOpenState: evidence.branchOpenState ?? "unknown",
      thresholdVersion: GAS_TREND_THRESHOLDS.version,
      thresholds: GAS_TREND_THRESHOLDS,
      reason
    }
  };
}

/**
 * Decide the shape of one channel's pressure over one window.
 *
 * Pure: it reads only its arguments, so every branch is testable without a
 * warehouse, a clock, or a LINE channel.
 */
export function evaluateGasTrend(samples: GasSample[], context: GasTrendContext): GasTrendDecision {
  const channel = isGasChannel(context.channel) ? context.channel : null;
  const windowFrom = context.window.from.getTime();
  const windowTo = context.window.to.getTime();

  if (!channel) {
    // Structural exclusion: `gas_detector_*` and anything else outside the
    // three pressure channels is not evaluated, so it cannot produce an alert.
    return unknownDecision(
      { channel: null, window: { from: context.window.from.toISOString(), to: context.window.to.toISOString() } },
      `channel_not_evaluable:${String(context.channel)}`
    );
  }

  const inWindow = samples.filter((sample) => {
    if (sample.channel !== channel) return false;
    const at = sample.recordedAt.getTime();
    return at >= windowFrom && at <= windowTo;
  });

  const withValue = inWindow
    .filter((sample): sample is GasSample & { valuePsi: number } => typeof sample.valuePsi === "number" && Number.isFinite(sample.valuePsi))
    .sort((left, right) => left.recordedAt.getTime() - right.recordedAt.getTime());

  const sampleCount = inWindow.length;
  const nonNullCount = withValue.length;
  const nullCount = sampleCount - nonNullCount;
  const coveragePct = sampleCount === 0 ? 0 : round((nonNullCount / sampleCount) * 100, 1);

  // Turn NULL rows into minutes using the observed spacing where possible, so
  // "no value for most of an hour" is a number rather than a hand-wave.
  const observedSpacing = withValue.length >= 2
    ? median(
        withValue
          .slice(1)
          .map((sample, index) => minutesBetween(withValue[index].recordedAt, sample.recordedAt))
          .filter((minutes) => minutes > 0)
      )
    : null;
  const spacingMinutes = observedSpacing ?? GAS_TREND_THRESHOLDS.fallbackSpacingMinutes;
  const nullMinutes = Math.round(nullCount * spacingMinutes);

  const windowLabel = { from: context.window.from.toISOString(), to: context.window.to.toISOString() };
  const base = {
    channel,
    window: windowLabel,
    sampleCount,
    nonNullCount,
    coveragePct,
    nullMinutes,
    machineState: context.machineState,
    temperatureC: context.temperatureC,
    branchOpenState: context.branchOpenState
  };

  if (sampleCount === 0) {
    return unknownDecision(base, "no_samples_in_window");
  }
  if (coveragePct < GAS_TREND_THRESHOLDS.minCoveragePct) {
    return unknownDecision(base, `coverage_below_minimum:${coveragePct}%<${GAS_TREND_THRESHOLDS.minCoveragePct}%`);
  }
  if (nonNullCount < GAS_TREND_THRESHOLDS.minSamples) {
    return unknownDecision(base, `too_few_samples:${nonNullCount}<${GAS_TREND_THRESHOLDS.minSamples}`);
  }

  const first = withValue[0];
  const last = withValue[nonNullCount - 1];
  const spanMinutes = Math.round(minutesBetween(first.recordedAt, last.recordedAt));
  const edge = GAS_TREND_THRESHOLDS.edgeSamples;
  const firstEdgePsi = median(withValue.slice(0, edge).map((sample) => sample.valuePsi));
  const lastEdgePsi = median(withValue.slice(-edge).map((sample) => sample.valuePsi));
  const slope = slopePerHour(withValue.map((sample) => ({ at: sample.recordedAt.getTime(), value: sample.valuePsi })));

  const measured = {
    ...base,
    spanMinutes,
    firstEdgePsi: firstEdgePsi === null ? null : round(firstEdgePsi, 2),
    lastEdgePsi: lastEdgePsi === null ? null : round(lastEdgePsi, 2),
    slopePsiPerHour: slope === null ? null : round(slope, 4)
  };

  if (spanMinutes < GAS_TREND_THRESHOLDS.minSpanMinutes) {
    return unknownDecision(measured, `span_too_short:${spanMinutes}min<${GAS_TREND_THRESHOLDS.minSpanMinutes}min`);
  }
  if (context.machineState === "unknown") {
    // No machine state means the reading cannot be attributed to consumption.
    return unknownDecision(measured, "machine_state_unknown", "machine_state_unknown");
  }
  if (context.temperatureC === null || !Number.isFinite(context.temperatureC)) {
    return unknownDecision(measured, "temperature_unknown", "temperature_unknown");
  }
  if (slope === null || firstEdgePsi === null || lastEdgePsi === null) {
    return unknownDecision(measured, "not_enough_spread_to_fit");
  }

  const drop = firstEdgePsi - lastEdgePsi;
  // The gate is the EDGE-MEDIAN rate, not the least-squares slope.
  //
  // Measured on production 2026-11-09 (six-hour window, machine running,
  // 69.09 °C): `gas_run_a_pressure` fell from a first-edge median of 80 psi to
  // a last-edge median of 68 psi — a 12 psi drop over 5.3 h, i.e. −2.26 psi/h —
  // while the fitted slope was only −0.14 psi/h, because the series is not
  // monotone. With the slope as the gate that real decline reads `steady`.
  // The fitted slope stays in the evidence (it is the honest description of the
  // whole series) but a noisy interior must not overturn what both edges agree
  // on: gas pressure oscillates as machines draw gas, so a regression over the
  // window systematically understates the direction the tank is moving.
  const spanHours = spanMinutes === 0 ? 0 : spanMinutes / 60;
  const edgeRatePsiPerHour = spanHours === 0 ? null : (lastEdgePsi - firstEdgePsi) / spanHours;
  const declining =
    edgeRatePsiPerHour !== null &&
    edgeRatePsiPerHour <= -GAS_TREND_THRESHOLDS.declinePsiPerHour &&
    drop >= GAS_TREND_THRESHOLDS.minDropPsi;

  const trend: GasTrendName = declining ? "declining" : "steady";
  const branchClosed = context.branchOpenState === "closed";
  return {
    trend,
    // A shut branch is the case the plan names: machines idle, pressure steady
    // is not a finding, and a decline across closed hours is not attributable
    // to consumption. The measurement is kept; the alert is withheld.
    alertable: declining && !branchClosed,
    suppression: declining && branchClosed ? "branch_closed" : null,
    evidence: {
      ...measured,
      edgeRatePsiPerHour: edgeRatePsiPerHour === null ? null : round(edgeRatePsiPerHour, 4),
      thresholdVersion: GAS_TREND_THRESHOLDS.version,
      thresholds: GAS_TREND_THRESHOLDS,
      reason: declining
        ? `declining:edgeRate=${round(edgeRatePsiPerHour ?? 0, 4)}psi/h,drop=${round(drop, 2)}psi,slope=${round(slope, 4)}psi/h`
        : `not_declining:edgeRate=${round(edgeRatePsiPerHour ?? 0, 4)}psi/h,drop=${round(drop, 2)}psi,slope=${round(slope, 4)}psi/h`
    }
  };
}

/**
 * Turn one evaluated channel into an iris-shaped alert, or null.
 *
 * The alert is deliberately phrased as a pressure trend *evaluated with* state
 * and temperature, and it names the exclusion in the message body. The `ruleId`
 * is prefixed `gas.` so its cooldown key can never collide with an IRIS rule id
 * (`cooldownKeyFor` is `<branch>:<ruleId>:<severity>`), and `claimNotification`
 * is reused unchanged.
 *
 * The id is bucketed by hour: two sweeps inside the same hour produce the same
 * id and therefore one `alert_notification` row per recipient, while a later
 * hour is a new occurrence the cooldown, not the id, is there to bound.
 */
export function gasAlertFromDecision(
  decision: GasTrendDecision,
  options: { branchId: string | null; windowEnd: Date }
): {
  id: string;
  branchId: string | null;
  machineId: null;
  ruleId: string;
  ruleUpdatedAt: null;
  ruleVersion: string;
  severity: string;
  title: string;
  detail: string;
  tags: string[];
  evidence: Record<string, unknown>;
  detectedAt: string;
  acknowledgedAt: null;
  coverage: Record<string, never>;
} | null {
  if (!decision.alertable || decision.trend !== "declining") return null;
  const channel = decision.evidence.channel;
  if (!channel) return null;
  const hourBucket = options.windowEnd.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const evidence = decision.evidence;
  const detail = [
    `ช่อง: ${channel}`,
    `แรงดัน ${evidence.firstEdgePsi ?? "?"} → ${evidence.lastEdgePsi ?? "?"} psi`,
    `ความชัน ${evidence.slopePsiPerHour ?? "?"} psi/ชม.`,
    `สถานะเครื่อง: ${evidence.machineState} · อุณหภูมิ: ${evidence.temperatureC ?? "?"} °C`,
    `หน้าต่าง: ${evidence.window.from} → ${evidence.window.to} (${evidence.spanMinutes} นาที, ครอบคลุม ${evidence.coveragePct}%)`,
    "เป็นการประเมินแนวโน้มร่วมกับสถานะเครื่องและอุณหภูมิ ไม่ใช่การตรวจจับแก๊สรั่ว"
  ].join(" · ");
  return {
    id: `gas:${channel}:declining:${hourBucket}`,
    branchId: options.branchId,
    machineId: null,
    ruleId: `gas.${channel}.declining`,
    ruleUpdatedAt: null,
    ruleVersion: evidence.thresholdVersion,
    severity: "warning",
    title: "แนวโน้มแรงดันแก๊สลดลงต่อเนื่อง",
    detail,
    tags: ["gas", "pressure", "trend"],
    evidence: evidence as unknown as Record<string, unknown>,
    detectedAt: options.windowEnd.toISOString(),
    acknowledgedAt: null,
    coverage: {}
  };
}
