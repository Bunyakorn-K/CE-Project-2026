// Presentation helpers for the R09 off-peak ranking.
//
// The ranking itself is server-side (apps/api/src/analytics/offpeak.ts) and its
// rules travel with the response. What lives here is the part that must not be
// lost in translation: an off-peak rank describes the *selected window only*,
// and a page that says "quiet times" without saying so turns a description of
// the past into a promise about the future.

export type OffPeakRow = {
  rank: number;
  dayOfWeek: number;
  weekday: string;
  hourOfDay: number;
  branchId: string;
  branchName: string;
  cycles: number;
  totalDurationMin: number;
};

export type OffPeakRules = {
  minCycles: number;
  percentile: number;
  eligibleBuckets: number;
  returnedBuckets: number;
};

const WEEKDAY_THAI = ["จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"] as const;

export function weekdayLabel(weekday: string, dayOfWeek: number): string {
  const index = dayOfWeek - 1;
  return WEEKDAY_THAI[index] ?? weekday ?? "ไม่ทราบ";
}

/** "03:00–04:00" — the hour bucket is [hourOfDay, hourOfDay+1) local time. */
export function hourRangeLabel(hourOfDay: number): string {
  if (!Number.isInteger(hourOfDay) || hourOfDay < 0 || hourOfDay > 23) return "ไม่ทราบ";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(hourOfDay)}:00–${pad((hourOfDay + 1) % 24)}:00`;
}

/**
 * Why the list is empty, in the words of the rule that emptied it. "No off-peak
 * time" and "no bucket cleared the minimum" are different findings and the page
 * must not collapse them.
 */
export function offPeakEmptyReason(rules: OffPeakRules | undefined): string {
  if (!rules) return "ยังไม่มีข้อมูลช่วงเวลาที่ไม่หนาแน่นสำหรับช่วงวันที่ที่เลือก";
  if (rules.eligibleBuckets === 0) {
    return `ไม่มีช่วงเวลาใดที่มีรอบซักถึงเกณฑ์ขั้นต่ำ ${rules.minCycles} รอบ — ข้อมูลในช่วงนี้น้อยเกินกว่าจะสรุปได้`;
  }
  return "ไม่มีช่วงเวลาที่ตรงเกณฑ์ในช่วงวันที่ที่เลือก";
}
