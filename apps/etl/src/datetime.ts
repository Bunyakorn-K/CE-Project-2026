// Centralized date/time helpers for the ETL pipeline.
//
// INVARIANT (data contract): every timestamp persisted to the analytics
// warehouse MUST be UTC. The ClickHouse server runs in UTC and `DateTime64`
// columns are interpreted as UTC. Never store wall-clock local time
// (e.g. Asia/Bangkok) without converting to UTC first — that silently
// shifts every row by the timezone offset and corrupts joins/correlations.
//
// All date handling in this project goes through date-fns / date-fns-tz so the
// timezone rules live in one place and are explicit, not inferred from the host.

import { format, formatISO, subDays, subHours, addHours } from "date-fns";
import { toZonedTime, fromZonedTime, formatInTimeZone } from "date-fns-tz";

/** Current time as a UTC Date. Use this instead of `new Date()`. */
export function nowUtc(): Date {
  return new Date();
}

/** Format a Date as a ClickHouse `DateTime64(3)` literal (UTC, no `Z`). */
export function toClickHouseUtc(d: Date): string {
  // date-fns `format` uses local TZ by default; force UTC via the tz option.
  return formatInTimeZone(d, "UTC", "yyyy-MM-dd HH:mm:ss.SSS");
}

/** Format a Date as ISO-8601 UTC (with `Z`) — for cursor watermarks / JSON. */
export function toIsoUtc(d: Date): string {
  return formatISO(d);
}

/**
 * Convert a TMD forecast timestamp to a UTC Date.
 * TMD returns e.g. "2026-09-07T15:00:00+07:00" (Asia/Bangkok local). The
 * offset suffix is authoritative; convert the zoned local time to UTC so the
 * warehouse stores a true UTC instant. Missing time → fall back to `now`.
 */
export function parseTmdTimestamp(raw: string | undefined, now: Date): Date {
  if (!raw) return now;
  // Strip only the offset, then treat the remainder as Bangkok local time.
  const local = raw.replace(/[+-]\d{2}:\d{2}$/, "");
  const parsed = new Date(local);
  if (Number.isNaN(parsed.getTime())) return now;
  // Interpret `parsed` as Asia/Bangkok wall-clock and convert to UTC.
  return fromZonedTime(parsed, "Asia/Bangkok");
}

/** Convert a UTC Date to Asia/Bangkok wall-clock (for display/chart axes). */
export function toBangkokWallClock(d: Date): Date {
  return toZonedTime(d, "Asia/Bangkok");
}

/** Format a UTC Date as a Bangkok date (YYYY-MM-DD) for daily grouping. */
export function toBangkokDate(d: Date): string {
  return formatInTimeZone(d, "Asia/Bangkok", "yyyy-MM-dd");
}

/** Days-ago helper for ETL fallback windows (UTC). */
export function daysAgoUtc(days: number): Date {
  return subDays(nowUtc(), days);
}

/** Shift a UTC instant by N hours (positive = future). */
export function shiftHoursUtc(d: Date, hours: number): Date {
  return hours >= 0 ? addHours(d, hours) : subHours(d, -hours);
}
