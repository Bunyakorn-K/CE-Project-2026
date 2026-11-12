// Presentation rules for the executive summary (GET /api/report/summary).
//
// The server builds the sentence; what it cannot know is whether the page that
// receives it has any data behind it. The summary counts cycles and machines,
// so over a window with no usage rows it renders a confident sentence about a
// period that was never measured — "this period had 0 cycles from 0 machines"
// reads as a finding about the branch when it is a gap in the warehouse.
// Suppressing it, and showing the empty-window message the dashboard already
// owns, is the honest move.

import { availabilityLabel, emptyStateMessage, usagePresence } from "./dashboard-view";

export type SummaryEnvelope = {
  source: string | null;
  availability: string | null;
  range: { from: string; to: string } | null;
  summary: string;
  generatedBy: string;
  generatedAt: string;
};

/** What the page may render for a summary, or why it may not render one. */
export type SummaryView =
  | { kind: "text"; text: string }
  | { kind: "hidden"; reason: string };

export function summaryView(input: {
  summary: string | null | undefined;
  /** The dashboard response's own presence count. The summary endpoint does not
   *  carry one, so the decision rides on the same measurement the KPIs do. */
  usageRowsInRange: number | null | undefined;
}): SummaryView {
  // Only "empty" suppresses. "unknown" means the source could not report
  // presence at all — the demo/IRIS path — and the server still computed a real
  // sentence, so hiding it would discard a genuine answer.
  const emptyReason = emptyStateMessage(usagePresence(input.usageRowsInRange));
  if (emptyReason) return { kind: "hidden", reason: emptyReason };

  const text = typeof input.summary === "string" ? input.summary.trim() : "";
  if (text.length === 0) return { kind: "hidden", reason: "ยังไม่มีสรุปสำหรับช่วงวันที่ที่เลือก" };

  return { kind: "text", text };
}

/**
 * The summary can be answered by IRIS as well as ClickHouse, so it carries the
 * IRIS contract names the dashboard envelope never sees. An unrecognised source
 * says so rather than falling back to the dashboard's loading wording, which
 * would claim the answer is still arriving when the server already sent it.
 */
export function summarySourceLabel(source: string | null | undefined): string {
  if (source === "clickhouse") return "แหล่งข้อมูล: ClickHouse";
  if (source === "postgres" || source === "durable-object") return "แหล่งข้อมูล: IRIS";
  if (source === "demo") return "โหมด Demo · ข้อมูลจำลอง";
  return "แหล่งข้อมูล: ไม่ทราบ";
}

/** "availability" is "how do I know this?", so it is stated next to the source.
 *
 *  An unrecognised value is named but not embedded: the contract field is a
 *  server-supplied string, and interpolating it into Thai copy would put an
 *  English enum straight into the sentence. */
export function summaryAvailabilityLabel(availability: string | null | undefined): string {
  if (availability === "usage-derived") return "สถานะจากข้อมูล usage · ไม่ใช่ live telemetry";
  if (availability === "available") return "ข้อมูลพร้อมใช้งาน";
  return availabilityLabel(availability);
}
/**
 * The sentence, split into parts that can be emphasised.
 *
 * The server joins four or five fragments with a middot and sends one string, and
 * the summary can also arrive from IRIS — so the page cannot assume a shape it
 * did not build. It reads what it was given instead: numbers with a unit are the
 * measurements, `฿` leads an amount, and a fragment that talks about a problem
 * marks its own numbers as the ones worth looking at.
 *
 * A number is never restyled by position or by order; only by what it says.
 */
export type SummaryTone = "plain" | "metric" | "money" | "attention";

export type SummarySegment = { text: string; tone: SummaryTone };

/** A measurement: a digit run, optionally with a Thai unit, or a `฿` amount. */
const MEASUREMENT = /฿\s?[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?\s*(?:%|รอบ|เครื่อง|รายการ|บาท|นาที|สาขา)/g;

/** Fragments whose numbers are a warning rather than a total. */
const ATTENTION = /ไม่พร้อม|ล่าช้า|ต้องติดตาม|ผิดปกติ|ตกต่ำ|เกินกำหนด/;

export function summarySegments(text: string): SummarySegment[] {
  const out: SummarySegment[] = [];
  const fragments = text.split("·").map((fragment) => fragment.trim()).filter(Boolean);

  fragments.forEach((fragment, index) => {
    if (index > 0) out.push({ text: " · ", tone: "plain" });
    const attention = ATTENTION.test(fragment);
    let cursor = 0;

    for (const match of fragment.matchAll(MEASUREMENT)) {
      const start = match.index ?? 0;
      if (start > cursor) out.push({ text: fragment.slice(cursor, start), tone: "plain" });
      const value = match[0];
      out.push({ text: value, tone: value.startsWith("฿") ? "money" : attention ? "attention" : "metric" });
      cursor = start + value.length;
    }

    if (cursor < fragment.length) out.push({ text: fragment.slice(cursor), tone: "plain" });
  });

  return out;
}
