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
 * THE WINDOW, STATED ONCE. IRIS alerts are swept over 7 days because an alert
 * older than that has either been acknowledged or is no longer actionable. The
 * window travels in the result, because a summary that does not name its window
 * cannot be re-measured.
 *
 * GAS. The result carries a `gas` block from the start so the shape does not
 * change when the pressure-trend evaluation lands; today it reports
 * `unavailable` with a reason rather than an empty list, because "we did not
 * evaluate" and "evaluated, nothing found" are different facts.
 */

import { timingSafeEqual } from "node:crypto";
import { runAlertSweep, type AlertEngineDeps, type AlertSweepSummary } from "./alert-engine";
import type { IrisAlert } from "./iris-read-client";

const IRIS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type GasSweepSummary = {
  /** `unavailable` means gas was not evaluated; it is never a silent 0. */
  state: "evaluated" | "unavailable";
  reason: string | null;
  window: { from: string; to: string } | null;
  evaluated: number;
  alertable: number;
  channels: unknown[];
  summary: AlertSweepSummary | null;
};

export type AlertSweepResult = {
  window: { from: string; to: string };
  scanned: number;
  lineConfigured: boolean;
  summary: AlertSweepSummary;
  gas: GasSweepSummary;
};

export type AlertSweepDeps = {
  fetchAlerts: (window: { from: string; to: string }) => Promise<IrisAlert[]>;
  adapter: AlertEngineDeps["adapter"];
  adapterAvailable: boolean;
  now?: () => Date;
  cooldownMs?: number;
  severityRoles?: Record<string, import("./access-policy").Role[]>;
};

/**
 * Constant-time token comparison for the scheduler credential.
 *
 * Same construction as `verifyMcpScope` (apps/api/src/analytics/mcp.ts:51): a
 * length check short-circuits, then `timingSafeEqual` on equal-length buffers.
 * An unset or empty `ALERT_SWEEP_TOKEN` validates nothing — a deployment that
 * forgot the configuration must fail closed, not accept every request.
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

/** The sweep itself. Identical for the owner button and the scheduler. */
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

  return {
    window,
    scanned: alerts.length,
    lineConfigured: deps.adapterAvailable,
    summary,
    gas: {
      state: "unavailable",
      reason: "gas_source_not_configured",
      window: null,
      evaluated: 0,
      alertable: 0,
      channels: [],
      summary: null
    }
  };
}
