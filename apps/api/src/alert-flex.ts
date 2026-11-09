/**
 * The alert as a LINE Flex Message — a card, not a wall of text.
 *
 * WHY A CARD. The text message this replaces was one 600-character paragraph
 * that wrapped into twelve lines on a phone: the reader had to hunt for the
 * pressure, and the two numbers that decide the alert (the edge rate the rule is
 * gated on, and the fitted slope kept for reference) sat in the middle of it,
 * unlabelled as such.
 *
 * WHAT MUST STAY TRUE. A card is a rendering, never a second source of truth:
 * every value here comes from the alert's own evidence, and anything missing
 * reads as `—`, not as 0 and not as a plausible-looking default. `altText` is the
 * text fallback LINE shows in notifications and on clients that cannot render a
 * flex message, so it has to stand alone — and LINE caps it at 400 characters.
 *
 * No LINE SDK types: this module builds plain JSON so it can be asserted in a
 * unit test without a client, and so a message can never be "valid" only because
 * the SDK coerced it.
 */

import type { IrisAlert } from "./iris-read-client";

export type FlexContents = Record<string, unknown>;

export const ALT_TEXT_LIMIT = 400;

type Severity = "critical" | "warning" | "info";

function severityOf(alert: IrisAlert): Severity {
  const value = String(alert.severity ?? "warning").toLowerCase();
  if (value === "critical" || value === "high" || value === "error") return "critical";
  if (value === "info" || value === "low") return "info";
  return "warning";
}

function severityStyle(severity: Severity) {
  if (severity === "critical") return { label: "CRITICAL", color: "#C0392B" };
  if (severity === "info") return { label: "INFO", color: "#2E6FB7" };
  return { label: "WARNING", color: "#D9822B" };
}

/** Numbers are formatted, never stringified: `68.57309385055319` is not a temperature. */
export function num(value: unknown, digits: number): string | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  return parsed.toFixed(digits);
}

function psi(value: unknown): string | null {
  const formatted = num(value, 0);
  return formatted === null ? null : `${formatted} psi`;
}

function rate(value: unknown): string | null {
  const formatted = num(value, 2);
  return formatted === null ? null : `${formatted} psi/ชม.`;
}

function text(content: string, options: Record<string, unknown> = {}) {
  return { type: "text", text: content, wrap: true, ...options };
}

function row(label: string, value: string, options: { strong?: boolean } = {}) {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    contents: [
      text(label, { size: "sm", color: "#6B7280", flex: 4 }),
      text(value, { size: "sm", color: "#111827", flex: 6, align: "end", weight: options.strong ? "bold" : "regular" })
    ]
  };
}

function evidenceOf(alert: IrisAlert): Record<string, unknown> {
  return (alert.evidence ?? {}) as Record<string, unknown>;
}

/**
 * The rows a reader needs, in the order they read them. Missing evidence drops
 * the row rather than inventing a value; a card with four true rows beats one
 * with eight where four say `—`.
 */
export function alertRows(alert: IrisAlert): Array<{ label: string; value: string; strong?: boolean }> {
  const evidence = evidenceOf(alert);
  const rows: Array<{ label: string; value: string; strong?: boolean }> = [];

  // Gas evidence, identified by its channel field.
  if (typeof evidence.channel === "string") {
    rows.push({ label: "ช่องวัด", value: String(evidence.channel), strong: true });
    const from = psi(evidence.firstEdgePsi);
    const to = psi(evidence.lastEdgePsi);
    if (from && to) rows.push({ label: "แรงดัน", value: `${from} → ${to}`, strong: true });
    const edge = rate(evidence.edgeRatePsiPerHour);
    if (edge) rows.push({ label: "อัตราลดลง (ใช้ตัดสิน)", value: edge, strong: true });
    const slope = rate(evidence.slopePsiPerHour);
    if (slope) rows.push({ label: "ความชัน (อ้างอิง)", value: slope });
    if (typeof evidence.machineState === "string") {
      rows.push({ label: "สถานะเครื่อง", value: String(evidence.machineState) });
    }
    const temperature = num(evidence.temperatureC, 1);
    if (temperature !== null) {
      const age = num(evidence.temperatureAgeHours, 0);
      const suffix = age !== null && Number(age) >= 1 ? ` (${age} ชม. ก่อน)` : "";
      rows.push({ label: "อุณหภูมิ", value: `${temperature} °C${suffix}` });
    }
    const window = evidence.window as { from?: string; to?: string } | undefined;
    const span = num(evidence.spanMinutes, 0);
    if (window?.from && window?.to) {
      rows.push({
        label: "หน้าต่าง",
        value: `${shortTime(window.from)} → ${shortTime(window.to)}${span ? ` (${span} นาที)` : ""}`
      });
    }
    const coverage = num(evidence.coveragePct, 1);
    const samples = num(evidence.sampleCount, 0);
    if (coverage !== null) {
      rows.push({
        label: "ความครอบคลุม",
        value: `${coverage}%${samples !== null ? ` · ${samples} ตัวอย่าง` : ""}`
      });
    }
    const nulls = num(evidence.nullMinutes, 0);
    if (nulls !== null && Number(nulls) > 0) rows.push({ label: "ช่วงที่อ่านไม่ได้", value: `${nulls} นาที` });
    return rows;
  }

  // Any other alert (IRIS, or a rule added later): its own fields, nothing invented.
  if (alert.machineId) rows.push({ label: "เครื่อง", value: alert.machineId });
  if (alert.branchId) rows.push({ label: "สาขา", value: alert.branchId });
  if (alert.detectedAt) rows.push({ label: "ตรวจพบ", value: shortTime(alert.detectedAt) });
  return rows;
}

/** `2026-11-09T13:00:00.600Z` → `11-09 20:00` in Asia/Bangkok, the branch's clock. */
export function shortTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(parsed);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

/** The card. `bubble` is the only container type that works in a one-message push. */
export function buildAlertFlex(alert: IrisAlert): { altText: string; contents: FlexContents } {
  const severity = severityOf(alert);
  const style = severityStyle(severity);
  const rows = alertRows(alert);
  const disclaimer = typeof alert.detail === "string" && alert.detail.includes("ไม่ใช่การตรวจจับแก๊สรั่ว")
    ? "เป็นการประเมินแนวโน้มร่วมกับสถานะเครื่องและอุณหภูมิ ไม่ใช่การตรวจจับแก๊สรั่ว"
    : null;

  const footerLines: string[] = [];
  if (alert.branchId) footerLines.push(`สาขา ${alert.branchId.slice(0, 8)}`);
  if (alert.detectedAt) footerLines.push(shortTime(alert.detectedAt));
  if (alert.ruleId) footerLines.push(alert.ruleId);

  const contents: FlexContents = {
    type: "bubble",
    size: "mega",
    header: {
      type: "box",
      layout: "vertical",
      backgroundColor: style.color,
      paddingAll: "16px",
      contents: [
        text(`🔔 LaundryTwin · ${style.label}`, { size: "xs", color: "#FFFFFF" }),
        text(alert.title, { size: "lg", color: "#FFFFFF", weight: "bold" })
      ]
    },
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      paddingAll: "16px",
      contents: rows.length > 0 ? rows.map((item) => row(item.label, item.value, { strong: item.strong })) : [text("ไม่มีรายละเอียดเพิ่มเติม", { size: "sm", color: "#6B7280" })]
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "xs",
      paddingAll: "12px",
      contents: [
        ...(disclaimer ? [text(disclaimer, { size: "xs", color: "#6B7280" })] : []),
        ...(footerLines.length > 0 ? [text(footerLines.join(" · "), { size: "xs", color: "#9CA3AF" })] : [])
      ]
    }
  };

  return { altText: buildAltText(alert, style.label, rows), contents };
}

/**
 * The text a notification banner shows. It has to survive on its own — a reader
 * who never opens LINE must still learn the channel, the drop and the rate — and
 * it has to fit in 400 characters, which is why it carries the strong rows only.
 */
export function buildAltText(alert: IrisAlert, label: string, rows: Array<{ label: string; value: string; strong?: boolean }>): string {
  const head = `🔔 LaundryTwin (${label}) ${alert.title}`;
  const strong = rows.filter((item) => item.strong).map((item) => `${item.label}: ${item.value}`);
  const parts = [head, ...strong];
  let out = parts.join(" · ");
  if (out.length > ALT_TEXT_LIMIT) out = `${out.slice(0, ALT_TEXT_LIMIT - 1)}…`;
  return out;
}
