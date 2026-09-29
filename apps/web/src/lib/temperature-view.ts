/** One temperature sample as returned by `/api/v1/analytics/temperature/curve`.
 *  `temperatureC` is null when the sample has no reading — a missing reading is
 *  never coerced to zero. */
export type TemperatureSample = { occurredAt: string; temperatureC: number | null };

/** Mirrors the API's `meta.truncation`. Present only when the server's row cap
 *  actually dropped part of the requested range. */
export type TemperatureTruncation = {
  returnedRows: number;
  totalRowsInRange: number;
  limit: number;
  kept: "newest";
};

export type TemperatureSummary = {
  /** Null when nothing was measured, so the panel can say so. */
  average: number | null;
  min: number | null;
  max: number | null;
  /** Samples with no reading, kept visible rather than folded into the maths. */
  unknown: number;
  /** False when the server capped the range: avg/min/max describe the returned
   *  rows only and must not be presented as covering `meta.range`. */
  coversFullRange: boolean;
  /** Thai truncation notice, or null when the range is complete. */
  coverage: string | null;
  /** Thai statement of the window the numbers actually cover, or null. */
  scopeNote: string | null;
};

const formatNumber = (value: number) => value.toLocaleString("th-TH");

function formatThaiDateTime(value: string): string {
  // ClickHouse returns "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
  // `new Date()` on that string is host-timezone dependent, so the offset is
  // stated explicitly rather than left to the browser's locale settings.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} ${date.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false })}`;
}

export function temperatureSummary(
  samples: TemperatureSample[],
  truncation?: TemperatureTruncation
): TemperatureSummary {
  const measured = samples.flatMap((sample) => (sample.temperatureC === null ? [] : [sample.temperatureC]));

  // A cap that returned no rows is not truncation, and a range with no rows is
  // an empty window the caller already reports as empty. Either way there is
  // nothing to describe, so no partial-coverage claim is made.
  const isTruncated = Boolean(truncation) && samples.length > 0;

  const oldest = samples[0]?.occurredAt ?? null;
  const newest = samples[samples.length - 1]?.occurredAt ?? null;

  return {
    average:
      measured.length > 0 ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null,
    min: measured.length > 0 ? Math.min(...measured) : null,
    max: measured.length > 0 ? Math.max(...measured) : null,
    unknown: samples.length - measured.length,
    coversFullRange: !isTruncated,
    coverage: isTruncated
      ? `แสดง ${formatNumber(samples.length)} จาก ${formatNumber(truncation!.totalRowsInRange)} แถว — ข้อมูลก่อนหน้านี้ไม่ได้แสดง`
      : null,
    scopeNote: isTruncated && oldest && newest ? `ค่านี้ครอบคลุมเฉพาะ ${formatThaiDateTime(oldest)} ถึง ${formatThaiDateTime(newest)}` : null
  };
}
