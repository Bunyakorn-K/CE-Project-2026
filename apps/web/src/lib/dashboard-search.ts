/**
 * The dashboard's working context as URL search params.
 *
 * View state used to live only in `useState`, so a LINE user tapping back landed
 * on "last 7 days, all branches", a desktop refresh lost it, and an owner could
 * not send "look at สาขา A, last Tuesday" to anyone. `e2e/dashboard.pw.ts`
 * already navigated to `/dashboard?from=…&to=…` against a route that ignored
 * those params, so the fixture setup was asserting nothing.
 *
 * Parsing is a pure function so the rules are testable without a router: a
 * malformed value must resolve to the same answer the component would render,
 * not throw inside a render.
 */

export type DashboardSearch = {
  view?: "dashboard" | "twin";
  branch?: string;
  from?: string;
  to?: string;
};

/** `YYYY-MM-DD`, and a real calendar date. `2026-02-31` is rejected: `Date`
 *  would roll it into March, so the URL could ask for a day that never existed. */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

export type DashboardContext = {
  view: "dashboard" | "twin";
  branchId: string;
  from: string;
  to: string;
  validRange: boolean;
};

/**
 * Resolves the URL's params against the 7-day default.
 *
 * A half-specified range keeps the end the URL gave and fills the other from the
 * default, which is the window that was actually asked for — "everything since
 * the 1st" is not an error. `validRange` is then false only when the result is
 * genuinely unusable: a non-calendar date, or `from` after `to`. In that case the
 * page says the range needs fixing instead of quietly querying something else.
 */
export function dashboardContext(search: DashboardSearch, fallback: { from: string; to: string }): DashboardContext {
  const view = search.view === "twin" ? "twin" : "dashboard";
  const branchId = typeof search.branch === "string" ? search.branch : "";

  const fromGiven = typeof search.from === "string" && search.from !== "";
  const toGiven = typeof search.to === "string" && search.to !== "";
  if (!fromGiven && !toGiven) {
    return { view, branchId, from: fallback.from, to: fallback.to, validRange: true };
  }

  const from = fromGiven ? (search.from as string) : fallback.from;
  const to = toGiven ? (search.to as string) : fallback.to;
  return { view, branchId, from, to, validRange: isCalendarDate(from) && isCalendarDate(to) && from <= to };
}

/** The params to write back. Defaults are omitted so the common URL stays short. */
export function dashboardSearch(context: DashboardContext, fallback: { from: string; to: string }): DashboardSearch {
  const search: DashboardSearch = {};
  if (context.view !== "dashboard") search.view = context.view;
  if (context.branchId) search.branch = context.branchId;
  if (context.from !== fallback.from) search.from = context.from;
  if (context.to !== fallback.to) search.to = context.to;
  return search;
}

/** A named window, in days ending today. `today` is 1. */
export const RANGE_PRESETS = [
  { id: "today", label: "วันนี้", days: 1 },
  { id: "7d", label: "7 วัน", days: 7 },
  { id: "30d", label: "30 วัน", days: 30 }
] as const;

export type RangePresetId = (typeof RANGE_PRESETS)[number]["id"];

function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The window ending today for a preset. `days` counts calendar days inclusive,
 *  so `today` is a single day and `7d` spans seven. */
export function presetRange(days: number, today: Date = new Date()): { from: string; to: string } {
  const from = new Date(today);
  from.setDate(today.getDate() - (days - 1));
  return { from: localDate(from), to: localDate(today) };
}
