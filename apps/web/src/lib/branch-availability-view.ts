/**
 * Web-side view of the branch's open state.
 *
 * The API decides `closed` (see `apps/api/src/report/branch-availability.ts`)
 * because it is the only layer that knows the branch's timezone and can read
 * the provisioned hours. This module does NOT re-derive that decision — it only
 * renders it, and it holds the web half of the same safety rule so a payload
 * from an older API cannot undo it.
 *
 * Why the web half exists at all: `closed` is additive, so an API build that
 * predates it simply omits the value. Rendering must therefore stay correct
 * whether the branch state arrives from the API or is absent, and `absent` must
 * mean "render what you always rendered" — never "assume closed". Assuming
 * closed client-side would silence the machine-fault warning on any account
 * talking to an older API, which is the precise failure this feature exists to
 * prevent.
 */

/** What the API reported about the branch. `unknown` is a real answer. */
export type BranchOpenState = "open" | "closed" | "unknown";

export type AvailabilityView = "fresh" | "stale" | "unavailable" | "closed";

/**
 * Combine a machine's evidence freshness with the branch state.
 *
 * Only a positive `closed` overrides. `unknown` and `open` pass freshness
 * through untouched, so an older API build, an unprovisioned schedule, and a
 * branch with no hours row all render exactly what they render today.
 *
 * An unrecognised state is treated as `unknown` rather than `closed`: only a
 * value this build actually recognises may soften the alarm.
 */
export function machineAvailability(
  freshness: string | null | undefined,
  branchState: string | null | undefined
): AvailabilityView {
  const base: AvailabilityView =
    freshness === "fresh" || freshness === "stale" || freshness === "unavailable"
      ? freshness
      : // Absent or unrecognised freshness renders as unavailable, which is
        // what an older payload already did. Defaulting to `fresh` would
        // invent a currency claim the payload never made.
        "unavailable";

  const state = branchState === "open" || branchState === "closed" ? branchState : "unknown";
  return state === "closed" ? "closed" : base;
}

/** True when this build can explain the closed state in Thai. */
export function explainsClosed(branchState: string | null | undefined): boolean {
  return branchState === "closed";
}