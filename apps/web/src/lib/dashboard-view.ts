/** Presence of usage evidence in the selected window, as reported by the API
 *  `dashboard.usageRowsInRange` field. "unknown" is a real state: a source that
 *  cannot count usage rows must not be presented as either empty or populated. */
export type UsagePresence = "empty" | "present" | "unknown";

/** `dim_machine.active = 1` inventory, not "machines that reported data". The
 *  machine-state query LEFT JOINs usage on purpose so active machines survive a
 *  window with no usage, so the count is inventory in every window. */
export const INVENTORY_LABEL = "เครื่องที่เปิดใช้งาน";
export const NO_USAGE_VALUE = "ไม่มีข้อมูล";
export const NO_USAGE_DETAIL = "ไม่มีแถวการใช้งานในช่วงเวลานี้";
export const NO_RUNNING_EVIDENCE_DETAIL = "ไม่มีหลักฐานสถานะกำลังใช้งานในช่วงเวลานี้";
export const NO_UTILIZATION_DETAIL = "ไม่มีข้อมูลการใช้งานในช่วงเวลานี้";
export const EMPTY_WINDOW_MESSAGE = "ไม่มีข้อมูลการใช้งานในช่วงเวลานี้";

export type MetricCell = { label: string; value: string; detail: string; textValue: boolean };

export type DashboardTotals = {
  revenueSatang: number | null;
  cycles: number;
  machines: number;
  running: number;
};

export type DashboardKpis = {
  revenue: MetricCell;
  cycles: MetricCell;
  inventory: MetricCell;
  branches: MetricCell;
};

export type DashboardBranch = {
  branchId: string;
  branchName: string;
  revenueSatang: number | null;
  cycles: number;
  machines: number;
  running: number;
};

export type BranchStatCells = {
  revenue: MetricCell;
  cycles: MetricCell;
  machines: MetricCell;
  running: MetricCell;
  /** The `running/machines` pill. It is a ratio of usage-derived states over
   *  inventory, so it is withheld when no usage evidence exists. */
  statusPill: string;
};

export type UtilizationView =
  | { kind: "unavailable"; message: string }
  | { kind: "ratio"; percentage: number; ariaLabel: string; ariaValueText: string };

export function usagePresence(usageRowsInRange: number | null | undefined): UsagePresence {
  if (usageRowsInRange === null || usageRowsInRange === undefined) return "unknown";
  if (!Number.isFinite(usageRowsInRange)) return "unknown";
  if (usageRowsInRange < 0) return "unknown";
  return usageRowsInRange === 0 ? "empty" : "present";
}

export function emptyStateMessage(presence: UsagePresence): string | null {
  return presence === "empty" ? EMPTY_WINDOW_MESSAGE : null;
}

function usageDerived<T>(presence: UsagePresence, value: T, empty: T): T {
  return presence === "present" ? value : empty;
}

export function dashboardKpis(input: {
  totals: DashboardTotals;
  branchCount: number;
  firstBranchName: string | null;
  range: string;
  presence: UsagePresence;
  formatNumber: (value: number) => string;
  formatBaht?: (satang: number) => string;
}): DashboardKpis {
  const { totals, presence, formatNumber } = input;
  const formatBaht = input.formatBaht ?? ((satang: number) => formatNumber(satang));
  const hasUsage = presence === "present";

  // Revenue has three distinct states: redacted by grant, absent because the
  // window is empty, and a real number. Only the last is a ฿ amount.
  const revenue: MetricCell =
    totals.revenueSatang === null
      ? { label: "รายได้รวม", value: "ไม่พร้อมใช้งาน", detail: "ไม่มีสิทธิ์ดูรายได้", textValue: true }
      : hasUsage
        ? { label: "รายได้รวม", value: formatBaht(totals.revenueSatang), detail: `${formatNumber(totals.cycles)} รอบซัก`, textValue: false }
        : { label: "รายได้รวม", value: NO_USAGE_VALUE, detail: NO_USAGE_DETAIL, textValue: true };

  const cycles: MetricCell = {
    label: "รอบซัก",
    value: hasUsage ? formatNumber(totals.cycles) : NO_USAGE_VALUE,
    // Naming the basis on the card is not decoration: `cycles` is a count of
    // usage ROWS (the canonical definition, 2026-09-29), not a count of
    // identified wash sessions, and the two differ wherever a row carries no
    // machine_session_id. See cycleAttributionView for the size of that gap.
    detail: hasUsage ? `นับจากแถว usage · ข้อมูล ${input.range}` : NO_USAGE_DETAIL,
    textValue: !hasUsage
  };

  const inventory: MetricCell = {
    label: INVENTORY_LABEL,
    value: formatNumber(totals.machines),
    detail: hasUsage ? `${formatNumber(totals.running)} รายการสถานะกำลังใช้งาน` : NO_RUNNING_EVIDENCE_DETAIL,
    textValue: false
  };

  const branches: MetricCell = {
    label: "สาขา",
    value: formatNumber(input.branchCount),
    detail: input.firstBranchName ?? "ไม่มีข้อมูลสาขา",
    textValue: false
  };

  return { revenue, cycles, inventory, branches };
}

export function branchStatCells(
  branch: DashboardBranch,
  presence: UsagePresence,
  formatNumber: (value: number) => string,
  formatBaht: (satang: number) => string
): BranchStatCells {
  const hasUsage = presence === "present";

  return {
    revenue: {
      label: "รายได้",
      value: branch.revenueSatang === null ? "ไม่พร้อมใช้งาน" : hasUsage ? formatBaht(branch.revenueSatang) : NO_USAGE_VALUE,
      detail: "",
      textValue: branch.revenueSatang === null || !hasUsage
    },
    cycles: {
      label: "รอบซัก",
      value: hasUsage ? formatNumber(branch.cycles) : NO_USAGE_VALUE,
      detail: "",
      textValue: !hasUsage
    },
    machines: { label: INVENTORY_LABEL, value: formatNumber(branch.machines), detail: "", textValue: false },
    running: {
      label: "รายการสถานะกำลังใช้งาน",
      value: hasUsage ? formatNumber(branch.running) : NO_USAGE_VALUE,
      detail: "",
      textValue: !hasUsage
    },
    statusPill: hasUsage
      ? `${formatNumber(branch.running)}/${formatNumber(branch.machines)} รายการสถานะ`
      : "ไม่มีหลักฐานสถานะในช่วงเวลานี้"
  };
}

/** running / machines is only a ratio when usage evidence exists for the
 *  window. Without it the numerator is unknown, not zero, so the bar resolves
 *  to the honest "no usage data" message instead of a 0% bar. */
export function utilizationView(
  branch: { branchName: string; machines: number; running: number },
  presence: UsagePresence
): UtilizationView {
  if (presence !== "present" || branch.machines === 0) {
    return { kind: "unavailable", message: NO_UTILIZATION_DETAIL };
  }

  const percentage = Math.round(Math.min(branch.running / branch.machines, 1) * 100);
  return {
    kind: "ratio",
    percentage,
    ariaLabel: `${branch.branchName}: รายการสถานะกำลังใช้งาน ${branch.running} จาก ${branch.machines} ${INVENTORY_LABEL}`,
    ariaValueText: `${percentage}% ของ${INVENTORY_LABEL}; ค่านี้มาจากรายการ usage ไม่ใช่สถานะทันที`
  };
}

export function usageRowsLabel(usageRowsInRange: number | null | undefined): string {
  if (usageRowsInRange === null || usageRowsInRange === undefined || !Number.isFinite(usageRowsInRange)) {
    return "แถว usage: ไม่ทราบจำนวน";
  }
  return `แถว usage ที่ได้: ${usageRowsInRange.toLocaleString("th-TH")}`;
}

// ---------------------------------------------------------------------------
// Cycle attribution
// ---------------------------------------------------------------------------

/** The `cycleAttribution` block of the dashboard envelope. `null` on the
 *  demo/IRIS path, which cannot measure attribution at all. */
export type CycleAttributionInput = {
  countedRows: number;
  attributedRows: number;
  unattributedRows: number;
} | null | undefined;

export const CYCLE_BASIS = "นับจากแถว usage";

export type CycleAttributionView =
  | { kind: "none" }
  | { kind: "unknown"; message: string }
  | { kind: "complete"; message: string }
  | { kind: "partial"; message: string; percentage: number };

/**
 * Renders how much of the cycle count rests on a `machine_session_id`.
 *
 * The cycle KPI counts usage rows. On the real warehouse 63.91% of usage rows
 * carry no session id at all, so the total is a correct count of work done and
 * an incomplete count of *identified* sessions. Saying so next to the number is
 * the difference between a measurement and a claim.
 *
 * `unknown` is a real state, not a failure case: the demo/IRIS projection has no
 * such field, so the gap is unmeasurable there and must not be rendered as
 * either complete or empty. `none` is the measured-empty window — nothing was
 * counted, so there is no attribution to describe, and the empty-window message
 * already covers it.
 */
export function cycleAttributionView(
  attribution: CycleAttributionInput,
  formatNumber: (value: number) => string = (value) => value.toLocaleString("th-TH")
): CycleAttributionView {
  if (
    !attribution ||
    !Number.isFinite(attribution.countedRows) ||
    !Number.isFinite(attribution.attributedRows) ||
    !Number.isFinite(attribution.unattributedRows) ||
    attribution.countedRows < 0 ||
    attribution.attributedRows < 0 ||
    attribution.unattributedRows < 0 ||
    attribution.attributedRows + attribution.unattributedRows !== attribution.countedRows
  ) {
    return {
      kind: "unknown",
      message: `${CYCLE_BASIS} · ไม่ทราบว่าแถวใดมีรหัสเซสชัน (machine_session_id) — แหล่งข้อมูลนี้ไม่ได้รายงาน`
    };
  }

  if (attribution.countedRows === 0) return { kind: "none" };

  if (attribution.unattributedRows === 0) {
    return {
      kind: "complete",
      message: `${CYCLE_BASIS} · ทุกแถวที่นับเป็นรอบมีรหัสเซสชัน (machine_session_id)`
    };
  }

  const percentage = Math.round((attribution.unattributedRows / attribution.countedRows) * 100);
  return {
    kind: "partial",
    percentage,
    message: [
      `${CYCLE_BASIS}`,
      `${formatNumber(attribution.unattributedRows)} จาก ${formatNumber(attribution.countedRows)} แถว (${percentage}%) ไม่มีรหัสเซสชัน (machine_session_id)`,
      "ตัวเลขรอบจึงยังไม่ครบถ้วน"
    ].join(" · ")
  };
}

export { usageDerived };
