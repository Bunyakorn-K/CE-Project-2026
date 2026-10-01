/**
 * Whether a branch is open right now, from operator-provisioned hours.
 *
 * WHY THIS EXISTS. Freshness (`usageFreshnessOf`) answers "how old is this
 * machine's newest usage evidence?". It is a per-machine fact with a30-minute
 * window. Measured on production 2026-10-01: 19 of 19 machines read
 * `unavailable` because the newest usage row was 52 minutes old — not because
 * anything was broken, but because the branch was shut for the night and no
 * usage rows arrive while a laundromat is closed.
 *
 * The web renders that state as `ไม่พร้อมใช้งาน` in `--danger` red, so a
 * closed branch presented as19 broken machines: one data fact (no recent usage)
 * asserting three things it cannot support — no evidence, machine unusable, and
 * something is wrong. The fix is a branch-level state, because "the branch is
 * shut" is a property of the branch and not of any machine.
 *
 * THE SAFETY RULE, which is the whole point of this module:
 *
 *   `closed` means "the branch is shut, so machine state is not observable".
 *   It NEVER means "assume the machines are fine".
 *
 * Two consequences are enforced below rather than left to reviewers:
 *
 * 1. An unknown or malformed schedule resolves to `unknown`, and `unknown`
 *    passes freshness through UNCHANGED. Defaulting an absent schedule to
 *    `closed` would mean one unpopulated row silently suppresses a genuine
 *    machine fault across an entire branch — the alarm would stop working
 *    exactly when it was needed.
 * 2. A machine with no evidence while the branch is OPEN stays `unavailable`.
 *    That is the case that actually warrants a technician, and `closed` must
 *    never swallow it.
 *
 * So the module can only ever make the alarm quieter when the schedule
 * positively says the branch is shut, and can never make it quieter otherwise.
 */

/** A branch's weekly opening hours, in the branch's own local time. */
export type BranchHours = {
  /** Minutes from local midnight, 0–1439. */
  openMinute: number;
  /** Minutes from local midnight, 0–1439. Exclusive: the branch is closed at
   *  this minute. May be less than `openMinute` for a branch that trades past
   *  midnight (open 22:00–02:00), which wraps. */
  closeMinute: number;
  /** ISO weekdays the branch trades on, 1 = Monday … 7 = Sunday. Empty means
   *  "every day", which is the common case and avoids making ops enumerate
   *  seven days for a branch that never closes. */
  openDays: number[];
};

/** What the schedule can tell us. `unknown` is a real answer, not a failure. */
export type BranchOpenState = "open" | "closed" | "unknown";

/** The three values the API can report. `closed` is new and additive: an older
 *  web build receiving it falls through to its unknown-freshness label rather
 *  than rendering it as `unavailable`. */
export type Availability = "fresh" | "stale" | "unavailable" | "closed";

/**
 * Is `hours` usable at all? Anything unrecognised is treated as absent, so a
 * typo in a provisioned row degrades to `unknown` instead of to a confident
 * wrong answer. Bounds are inclusive where they should be: `closeMinute` of
 * 1440 is a legitimate "closes at midnight".
 */
export function isUsableHours(hours: BranchHours | null | undefined): hours is BranchHours {
  if (!hours) return false;
  const { openMinute, closeMinute, openDays } = hours;
  if (!Number.isInteger(openMinute) || !Number.isInteger(closeMinute)) return false;
  if (openMinute < 0 || openMinute > 1439) return false;
  if (closeMinute < 0 || closeMinute > 1440) return false;
  if (openMinute === closeMinute) return false; // zero-length or 24h-at-one-instant: not a schedule
  if (!Array.isArray(openDays)) return false;
  return openDays.every((d) => Number.isInteger(d) && d >= 1 && d <= 7);
}

/**
 * Resolve the branch's open state from its hours and the current local time.
 *
 * `localMinute` and `localIsoWeekday` are injected rather than read from the
 * clock so the decision is testable and so the caller controls which timezone
 * the arithmetic happens in. See `localTimeInZone`.
 */
export function branchOpenState(
  hours: BranchHours | null | undefined,
  localMinute: number,
  localIsoWeekday: number
): BranchOpenState {
  if (!isUsableHours(hours)) return "unknown";
  const { openMinute, closeMinute, openDays } = hours;

  // An empty `openDays` means "trades every day". Checked before the weekday
  // so a seven-day branch never reads closed for a scheduling mistake.
  if (openDays.length > 0 && !openDays.includes(localIsoWeekday)) return "closed";

  // Wrapping window (22:00–02:00): the close boundary is earlier than the open
  // one, so "now" is inside when it is late OR early.
  if (closeMinute < openMinute) {
    return localMinute >= openMinute || localMinute < closeMinute ? "open" : "closed";
  }
  // Simple window. `closeMinute` is exclusive, so a branch closing at 22:00 is
  // already closed at 22:00 — otherwise a machine would read open for the
  // whole closing minute.
  return localMinute >= openMinute && localMinute < closeMinute ? "open" : "closed";
}

/**
 * Combine a machine's evidence age with the branch's open state.
 *
 * `closed` REPLACES the evidence verdict rather than accompanying it: a shut
 * branch shows one calm state, not a red pill beside a grey one. It is applied
 * only when the schedule positively says `closed` — `unknown` and `open` both
 * pass `freshness` through untouched, so an unpopulated schedule renders
 * exactly what it renders today.
 */
export function effectiveAvailability(freshness: Availability, openState: BranchOpenState): Availability {
  return openState === "closed" ? "closed" : freshness;
}

/**
 * The branch's local wall-clock minute and ISO weekday.
 *
 * Uses `Intl.DateTimeFormat` with an explicit `timeZone` so the answer follows
 * the branch's own clock rather than the server's. An unknown zone throws, and
 * a laundromat that reports an unusable timezone must not be treated as shut —
 * so the caller receives null and resolves to `unknown`.
 */
export function localTimeInZone(timeZone: string, at: Date): { minute: number; isoWeekday: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false
    }).formatToParts(at);

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    // `hour12: false` can render midnight as "24" in some ICU versions.
    const hour = Number(get("hour")) % 24;
    const minute = Number(get("minute"));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

    // en-US short weekday → ISO number. Avoids depending on the server's locale.
    const weekdays: Record<string, number> = {
      Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7
    };
    const isoWeekday = weekdays[get("weekday")];
    if (isoWeekday === undefined) return null;

    return { minute: hour * 60 + minute, isoWeekday };
  } catch {
    return null;
  }
}

/**
 * Convenience: hours + timezone + instant → open state. Falls back to
 * `unknown` whenever the zone cannot be resolved, so an unusable timezone is
 * never mistaken for a closed branch.
 */
export function resolveBranchOpenState(
  hours: BranchHours | null | undefined,
  timeZone: string,
  at: Date
): BranchOpenState {
  const local = localTimeInZone(timeZone, at);
  if (!local) return "unknown";
  return branchOpenState(hours, local.minute, local.isoWeekday);
}