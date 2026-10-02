/**
 * A `YYYY-MM-DD` string that is a real day on the calendar.
 *
 * The shape test alone is not enough, and this is the reason the function
 * exists: `Date.parse("2026-02-31")` is a valid timestamp, because the engine
 * rolls it into March rather than rejecting it. A `/^\d{4}-\d{2}-\d{2}$/`
 * check therefore accepts a day that never happened, and a range or a chart
 * axis built from one silently shows 3 March while claiming 31 February.
 *
 * Round-tripping through `toISOString` is what catches it — the engine
 * normalises the overflow, so formatting it back does not reproduce the input.
 *
 * Exported from its own module rather than kept in `apps/api/src/index.ts`,
 * because `index.ts` is the app entry and importing it from a report module
 * would create a cycle. It was duplicated by being trapped there: the report
 * layer could not reach the only correct version of this rule, which is how a
 * regex-only copy appeared in the first place.
 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}