import { freshnessMeta, machineStatusMeta, type FreshnessMeta } from "./machine-status";

/**
 * How the live machine page may present a machine's state.
 *
 * The page used to render `machineStatusMeta(state)` as a coloured pill
 * unconditionally, above a freshness pill computed from the same card. On
 * production that produced 17 of 19 cards reading `กำลังใช้งาน` in a green
 * success pill directly above `ไม่พร้อมใช้งาน` — the loudest element on the
 * card asserting a live machine state that the card itself disclaims two rows
 * down. A green pill is a claim, and a claim contradicted by its own card is
 * worse than no claim at all.
 *
 * The twin page already carries the same axis as a separate freshness pill and
 * had its machine illustration removed for exactly this reason. The live page
 * has the pill and never the guard, so the guard is what this decides.
 *
 * Three cases, because freshness and status are different questions:
 *
 * - `fresh`    the row is current, so the state is stated plainly.
 * - `stale`    the row is real but old. The state is still stated, but not in
 *              success colour and not as the present tense — `สถานะล่าสุด`
 *              is what the evidence supports.
 * - `unavailable` there is no recent evidence at all. The state is withheld
 *              and the card says so. The last recorded value is preserved as
 *              history, never promoted back into the headline.
 */

export type LiveStatusClaim =
  | { kind: "current"; label: string; className: string }
  | { kind: "last-recorded"; label: string; className: string; recordedLabel: string }
  | { kind: "withheld"; label: string; className: string; recordedLabel: string | null };

/** `stale` must not wear the success colour: the row is old, not healthy. */
const STALE_CLASS = "status-pill--warning";
const WITHHELD_CLASS = "status-pill--neutral";

export function liveStatusClaim(
  machine: { state: string | null | undefined; freshness: string | null | undefined }
): LiveStatusClaim {
  const status = machineStatusMeta(machine.state);
  // Keyed on the raw enum, not on the Thai label. A copy change to
  // `freshnessMeta` would otherwise silently invert which branch withholds a
  // state, and the failure would be invisible: a card would start asserting a
  // machine's state again, in the same green.
  const freshness = machine.freshness;

  if (freshness === "unavailable") {
    return {
      kind: "withheld",
      label: "ไม่ทราบสถานะปัจจุบัน",
      className: WITHHELD_CLASS,
      // A machine whose last usage row said `running` has a *history* of
      // running. Naming it here is honest; promoting it to the headline is the
      // bug this function exists to prevent.
      recordedLabel: machine.state ? `บันทึกล่าสุดว่า ${status.label}` : null
    };
  }

  if (freshness === "stale") {
    return { kind: "last-recorded", label: `สถานะล่าสุด: ${status.label}`, className: STALE_CLASS, recordedLabel: status.label };
  }

  return { kind: "current", label: status.label, className: status.className };
}

/** The freshness pill, or null when the payload carries no freshness at all. */
export function liveFreshnessRow(freshness: string | null | undefined): FreshnessMeta | null {
  if (!freshness) return null;
  return freshnessMeta(freshness);
}

/**
 * Whether the snapshot's own state source is available, and why not.
 *
 * The API states this per machine as `coverage.liveState`, and the page used to
 * drop the field entirely — so the page whose whole subject is machine state
 * never said that it has none, and a reader had no way to tell usage-derived
 * state from live telemetry. Absent is not the same as unavailable: an older
 * build carrying no coverage asserts nothing rather than claiming a source is
 * missing.
 */
export type LiveStateSource =
  | { known: false }
  | { available: true; reason: null }
  | { available: false; reason: string };

export function liveStateSource(coverage: { liveState?: { available: boolean; reason?: string } } | null | undefined): LiveStateSource {
  const liveState = coverage?.liveState;
  if (!liveState) return { known: false };
  if (liveState.available) return { available: true, reason: null };
  return { available: false, reason: liveState.reason ?? "ไม่ทราบเหตุผลที่ไม่มีข้อมูลสด" };
}

/** What kind of machine this is, in words. */
export function machineKindLabel(kind: string | null | undefined): string {
  if (kind === "washer") return "เครื่องซักผ้า";
  if (kind === "dryer") return "เครื่องอบผ้า";
  return kind || "ไม่ระบุประเภท";
}