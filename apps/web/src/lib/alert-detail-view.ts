// The alert detail page, as data.
//
// The card in LINE carries four facts and a link; this is everything the link
// opens. It is a pure module so the ordering, the Thai labels and the number
// formatting can be tested without a browser — the page component only renders
// what this returns.
//
// Two rules it inherits from the server contract: a missing value is shown as
// "—" and never as 0, and a value that came from a lagged reading says so.

export type AlertEvidence = Record<string, unknown>;

export type AlertDetail = {
  id: string;
  branchId: string | null;
  machineId: string | null;
  severity: string;
  title: string;
  message: string;
  evidence: AlertEvidence;
  status: string;
  attemptedAt: string;
  deliveredAt: string | null;
  error: string | null;
};

export type DetailRow = { label: string; value: string };

export function severityMeta(severity: string): { label: string; tone: "critical" | "warning" | "info" } {
  const value = severity.toLowerCase();
  if (value === "critical" || value === "high" || value === "error") return { label: "วิกฤต", tone: "critical" };
  if (value === "info" || value === "low") return { label: "ข้อมูล", tone: "info" };
  return { label: "เตือน", tone: "warning" };
}

function fixed(value: unknown, digits: number): string | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : null;
}

function dash(value: string | null): string {
  return value ?? "—";
}

export function formatBangkok(value: unknown): string {
  if (typeof value !== "string" || value === "") return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(parsed);
}

/**
 * The evidence as an ordered list. Order matters: the two numbers that decide the
 * alert come first, the context that qualifies them next, the plumbing last —
 * rather than Object.keys order, which is insertion order and happened to put
 * `branchOpenState` at the top of the JSON.
 */
export function detailRows(alert: AlertDetail): DetailRow[] {
  const evidence = alert.evidence ?? {};
  const rows: DetailRow[] = [];

  const channel = evidence.channel;
  if (typeof channel === "string") rows.push({ label: "ช่องวัด", value: channel });

  const first = fixed(evidence.firstEdgePsi, 0);
  const last = fixed(evidence.lastEdgePsi, 0);
  if (first !== null || last !== null) {
    rows.push({ label: "แรงดัน (หัวช่วง → ท้ายช่วง)", value: `${dash(first)} → ${dash(last)} psi` });
  }

  const edge = fixed(evidence.edgeRatePsiPerHour, 2);
  if (edge !== null) rows.push({ label: "อัตราลดลง (ตัวที่ใช้ตัดสิน)", value: `${edge} psi/ชม.` });

  const slope = fixed(evidence.slopePsiPerHour, 2);
  if (slope !== null) rows.push({ label: "ความชันเชิงเส้น (อ้างอิง)", value: `${slope} psi/ชม.` });

  if (evidence.machineState !== undefined) {
    rows.push({ label: "สถานะเครื่อง", value: String(evidence.machineState) });
  }

  const temperature = fixed(evidence.temperatureC, 1);
  if (temperature !== null) {
    const age = fixed(evidence.temperatureAgeHours, 0);
    const suffix = age !== null && Number(age) >= 1 ? ` (อ่านล่าสุด ${age} ชม. ก่อน)` : "";
    rows.push({ label: "อุณหภูมิ", value: `${temperature} °C${suffix}` });
  }

  const window = evidence.window as { from?: unknown; to?: unknown } | undefined;
  if (window?.from && window?.to) {
    rows.push({ label: "หน้าต่างการวัด", value: `${formatBangkok(window.from)} → ${formatBangkok(window.to)}` });
  }

  const span = fixed(evidence.spanMinutes, 0);
  if (span !== null) rows.push({ label: "ความยาวหน้าต่าง", value: `${span} นาที` });

  const coverage = fixed(evidence.coveragePct, 1);
  if (coverage !== null) rows.push({ label: "ความครอบคลุมข้อมูล", value: `${coverage}%` });

  const samples = fixed(evidence.sampleCount, 0);
  if (samples !== null) rows.push({ label: "จำนวนตัวอย่าง", value: samples });

  const nulls = fixed(evidence.nullMinutes, 0);
  if (nulls !== null) rows.push({ label: "นาทีที่อ่านค่าไม่ได้ (NULL)", value: `${nulls} นาที` });

  const branchOpen = evidence.branchOpenState;
  if (branchOpen !== undefined) rows.push({ label: "สถานะเวลาทำการสาขา", value: String(branchOpen) });

  const thresholds = evidence.thresholdVersion;
  if (thresholds !== undefined) rows.push({ label: "ชุดเกณฑ์ที่ใช้", value: String(thresholds) });

  if (alert.branchId) rows.push({ label: "สาขา", value: alert.branchId });
  if (alert.machineId) rows.push({ label: "เครื่อง", value: alert.machineId });
  rows.push({ label: "รหัสการแจ้งเตือน", value: alert.id });

  return rows;
}

/** What happened to the message, in the reader's words rather than the row's. */
export function deliveryLine(alert: AlertDetail): { text: string; tone: "ok" | "failed" | "pending" } {
  if (alert.status === "sent") {
    return { text: `ส่งถึง LINE แล้ว · ${formatBangkok(alert.deliveredAt ?? alert.attemptedAt)}`, tone: "ok" };
  }
  if (alert.status === "failed") {
    return { text: `ส่งไม่สำเร็จ · ${alert.error ?? "ไม่ทราบสาเหตุ"}`, tone: "failed" };
  }
  return { text: `กำลังส่ง · ${formatBangkok(alert.attemptedAt)}`, tone: "pending" };
}

/**
 * The evidence object is the whole truth, including fields this page does not
 * label. Showing the raw JSON under the formatted rows is how a reader checks
 * that nothing was quietly dropped.
 */
export function rawEvidenceJson(alert: AlertDetail): string {
  return JSON.stringify(alert.evidence ?? {}, null, 2);
}
