/**
 * One alert sweep, callable by a human and by a scheduler.
 *
 * WHY THIS MODULE EXISTS. `runAlertSweep` was already correct — idempotent per
 * (alert, recipient), cooldown per alert class, claim-then-mark, audited skips —
 * and nothing ran it. Its only caller was an owner pressing a button, which is
 * the one thing R05 ("event-driven notifications with cooldowns") cannot be.
 * Adding a second caller by copying the handler body is the failure mode this
 * repository has already paid for twice (one contract, two copies, drift), so
 * both routes call `performAlertSweep` and the shape they return is identical
 * by construction rather than by agreement.
 *
 * THE WINDOWS, STATED ONCE. IRIS alerts are swept over 7 days because an alert
 * older than that has either been acknowledged or is no longer actionable. Gas
 * is evaluated over 6 hours because a pressure trend needs at least 3 hours of
 * history and a 6-hour window leaves room for the collector's hourly cadence.
 * Both windows travel in the result, because a summary that does not name its
 * window cannot be re-measured.
 */

import { timingSafeEqual } from "node:crypto";
import type { ClickHouseExecutor } from "./analytics/clickhouse";
import { runAlertSweep, type AlertEngineDeps, type AlertSweepSummary } from "./alert-engine";
import {
  GAS_CHANNELS,
  evaluateGasTrend,
  gasAlertFromDecision,
  type GasChannel,
  type GasSample,
  type GasTrendDecision,
  type MachineStateLike
} from "./gas-trend";
import type { IrisAlert } from "./iris-read-client";
import { resolveBranchOpenState } from "./report/branch-availability";
import { queryBranchHours } from "./report/clickhouse-report";

const IRIS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const GAS_WINDOW_HOURS = 6;
const DEFAULT_BRANCH_TIMEZONE = "Asia/Bangkok";

export type GasChannelSummary = {
  channel: GasChannel;
  trend: GasTrendDecision["trend"];
  alertable: boolean;
  suppression: GasTrendDecision["suppression"];
  coveragePct: number;
  sampleCount: number;
  nullMinutes: number;
  reason: string;
};

export type GasSweepSummary = {
  /** `unavailable` means the gas source could not be read; it is never a 0. */
  state: "evaluated" | "unavailable";
  reason: string | null;
  window: { from: string; to: string } | null;
  /** How many channels were evaluated (0 when the source was unavailable). */
  evaluated: number;
  alertable: number;
  channels: GasChannelSummary[];
  /** The sweep summary for the gas-derived alerts alone, or null. */
  summary: AlertSweepSummary | null;
};

export type AlertSweepResult = {
  window: { from: string; to: string };
  scanned: number;
  lineConfigured: boolean;
  summary: AlertSweepSummary;
  gas: GasSweepSummary;
};

export type GasSweepDeps = {
  clickhouse: ClickHouseExecutor;
  /** Branch the gas source belongs to; the warehouse rows also carry it. */
  branchId?: string | null;
  branchTimezone?: string;
  windowHours?: number;
};

export type AlertSweepDeps = {
  fetchAlerts: (window: { from: string; to: string }) => Promise<IrisAlert[]>;
  adapter: AlertEngineDeps["adapter"];
  adapterAvailable: boolean;
  now?: () => Date;
  cooldownMs?: number;
  severityRoles?: Record<string, import("./access-policy").Role[]>;
  /**
   * Optional: without it the sweep still runs and reports gas as
   * `unavailable` with a reason, which is a different fact from "measured, no
   * finding" — the same three-state rule the report routes follow.
   */
  gas?: GasSweepDeps;
};

/**
 * Constant-time token comparison for the scheduler credential.
 *
 * Same construction as `verifyMcpScope` (apps/api/src/analytics/mcp.ts:51): a
 * length check short-circuits, then `timingSafeEqual` on equal-length buffers.
 * An unset or empty `ALERT_SWEEP_TOKEN` validates nothing — a deployment that
 * forgot to configure the token must fail closed, not accept every request.
 */
export function isAlertSweepTokenValid(
  provided: string | null | undefined,
  expected: string | undefined
): boolean {
  if (!expected || expected.length === 0) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/** One channel's pressure samples, read with bound parameters. */
export async function queryGasSamples(
  clickhouse: ClickHouseExecutor,
  window: { from: Date; to: Date }
): Promise<Array<GasSample & { branchId: string | null }>> {
  const rows = await clickhouse<{ channel: string; recorded_at: string; value_psi: number | string | null; branch_id: string }>(
    `SELECT channel, toString(recorded_at) AS recorded_at, value_psi, toString(branch_id) AS branch_id
FROM fact_gas_pressure_sample FINAL
WHERE recorded_at >= {from:DateTime64(3)} AND recorded_at <= {to:DateTime64(3)}
  AND channel IN ({channelA:String}, {channelB:String}, {channelC:String})
ORDER BY recorded_at`,
    {
      from: window.from.toISOString().slice(0, 23),
      to: window.to.toISOString().slice(0, 23),
      channelA: GAS_CHANNELS[0],
      channelB: GAS_CHANNELS[1],
      channelC: GAS_CHANNELS[2]
    }
  );
  return rows.map((row) => ({
    channel: row.channel,
    branchId: row.branch_id ? String(row.branch_id) : null,
    recordedAt: new Date(`${row.recorded_at.replace(" ", "T")}Z`),
    // NULL stays NULL. A `unavailable` sample is stored as NULL by contract, so
    // coercing here would be the exact defect the gas contract forbids.
    valuePsi: row.value_psi === null || row.value_psi === undefined ? null : Number(row.value_psi)
  }));
}

/**
 * Machine state and temperature over the same window.
 *
 * Both are required by R06 before a pressure decline may be called a finding,
 * and each failure is `unknown` rather than a default: an unreadable table is
 * not "all machines idle", and a missing temperature is not 20 °C.
 */
export async function queryGasContext(
  clickhouse: ClickHouseExecutor,
  window: { from: Date; to: Date }
): Promise<{ machineState: MachineStateLike; temperatureC: number | null }> {
  const params = {
    from: window.from.toISOString().slice(0, 19).replace("T", " "),
    to: window.to.toISOString().slice(0, 19).replace("T", " ")
  };
  let machineState: MachineStateLike = "unknown";
  let temperatureC: number | null = null;
  try {
    const rows = await clickhouse<{ running: string | number }>(
      `SELECT countIf(status = 'running') AS running
FROM fact_machine_usage FINAL
WHERE started_at >= {from:DateTime} AND started_at <= {to:DateTime}`,
      params
    );
    machineState = Number(rows[0]?.running ?? 0) > 0 ? "running" : "idle";
  } catch {
    machineState = "unknown";
  }
  try {
    const rows = await clickhouse<{ avg_c: number | string | null }>(
      `SELECT avg(temperature_c) AS avg_c
FROM fact_temperature_sample
WHERE recorded_at >= {from:DateTime} AND recorded_at <= {to:DateTime} AND temperature_c IS NOT NULL`,
      params
    );
    const value = rows[0]?.avg_c;
    temperatureC = value === null || value === undefined ? null : Number(value);
    if (temperatureC !== null && !Number.isFinite(temperatureC)) temperatureC = null;
  } catch {
    temperatureC = null;
  }
  return { machineState, temperatureC };
}

function unavailableGas(reason: string): GasSweepSummary {
  return { state: "unavailable", reason, window: null, evaluated: 0, alertable: 0, channels: [], summary: null };
}

/**
 * Evaluate all three pressure channels for the window and push only the
 * alertable ones through the same engine IRIS alerts use.
 */
async function sweepGas(deps: GasSweepDeps, now: Date, engine: Omit<AlertEngineDeps, "adapterAvailable">): Promise<GasSweepSummary> {
  const windowHours = deps.windowHours ?? GAS_WINDOW_HOURS;
  const window = { from: new Date(now.getTime() - windowHours * 60 * 60 * 1000), to: now };
  let samples: Array<GasSample & { branchId: string | null }>;
  try {
    samples = await queryGasSamples(deps.clickhouse, window);
  } catch (error) {
    return unavailableGas(`gas_source_unavailable:${error instanceof Error ? error.message : String(error)}`);
  }

  const branchId = deps.branchId ?? samples.find((sample) => sample.branchId)?.branchId ?? null;
  const { machineState, temperatureC } = await queryGasContext(deps.clickhouse, window);
  const hours = branchId ? await queryBranchHours(deps.clickhouse, branchId) : new Map();
  // Only a schedule that POSITIVELY says "shut" suppresses an alert; an absent
  // or unreadable schedule resolves `unknown` and suppresses nothing.
  const branchOpenState = branchId
    ? resolveBranchOpenState(hours.get(branchId), deps.branchTimezone ?? DEFAULT_BRANCH_TIMEZONE, now)
    : "unknown";

  const decisions = GAS_CHANNELS.map((channel) =>
    evaluateGasTrend(samples, { channel, window, machineState, temperatureC, branchOpenState })
  );

  const alerts = decisions
    .map((decision) => gasAlertFromDecision(decision, { branchId, windowEnd: now }))
    .filter((alert): alert is NonNullable<typeof alert> => alert !== null);

  const summary = alerts.length > 0
    ? await runAlertSweep(alerts as unknown as IrisAlert[], engine)
    : null;

  return {
    state: "evaluated",
    reason: null,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    evaluated: decisions.length,
    alertable: alerts.length,
    channels: decisions.map((decision, index) => ({
      channel: GAS_CHANNELS[index],
      trend: decision.trend,
      alertable: decision.alertable,
      suppression: decision.suppression,
      coveragePct: decision.evidence.coveragePct,
      sampleCount: decision.evidence.sampleCount,
      nullMinutes: decision.evidence.nullMinutes,
      reason: decision.evidence.reason
    })),
    summary
  };
}

/**
 * The sweep itself. Identical for the owner button and the scheduler.
 */
export async function performAlertSweep(deps: AlertSweepDeps): Promise<AlertSweepResult> {
  const nowDate = deps.now ? deps.now() : new Date();
  const from = new Date(nowDate.getTime() - IRIS_WINDOW_MS);
  const window = { from: from.toISOString(), to: nowDate.toISOString() };

  const alerts = await deps.fetchAlerts(window);
  const engine: AlertEngineDeps = {
    adapter: deps.adapter,
    adapterAvailable: deps.adapterAvailable,
    now: () => nowDate,
    ...(deps.cooldownMs !== undefined ? { cooldownMs: deps.cooldownMs } : {}),
    ...(deps.severityRoles ? { severityRoles: deps.severityRoles } : {})
  };
  const summary = await runAlertSweep(alerts, engine);

  const gas = deps.gas
    ? await sweepGas(deps.gas, nowDate, engine)
    : unavailableGas("gas_source_not_configured");

  return {
    window,
    scanned: alerts.length,
    lineConfigured: deps.adapterAvailable,
    summary,
    gas
  };
}
