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
  /** The pill's status color, as a `status-pill--*` class.
   *
   *  This colors the *evidence*, not the branch's health. `running/machines`
   *  derives from usage rows rather than live telemetry, so a high ratio means
   *  "the warehouse saw activity here", never "this branch is performing". The
   *  color therefore has exactly three bands and no red: an unmeasurable branch
   *  and a measured-idle one must not read alike, but neither is a fault. See
   *  `utilizationView`, whose `ariaValueText` already states the basis. */
  statusClassName: string;
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
    // A branch is named only when it is the whole scope. Over several branches,
    // naming whichever sorted first reads as though the card had identified one,
    // so the detail states what the count is bounded by instead.
    detail:
      input.branchCount === 0
        ? "ไม่มีข้อมูลสาขา"
        : input.branchCount === 1 && input.firstBranchName
          ? input.firstBranchName
          : "นับเฉพาะสาขาที่คุณมีสิทธิ์",
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
      : "ไม่มีหลักฐานสถานะในช่วงเวลานี้",
    statusClassName: hasUsage
      ? branch.running > 0
        ? "status-pill--success"
        : "status-pill--warning"
      : "status-pill--neutral"
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
 * The cycle KPI counts usage rows. On the real warehouse 67.8933% of usage rows
 * carry no session id at all (5,369 of 7,908, measured 2026-09-30 11:39:11 UTC;
 * 63.91% of 4,458 rows on 2026-09-29), so the total is a correct count of work
 * done and an incomplete count of *identified* sessions. Saying so next to the
 * number is the difference between a measurement and a claim. The share is a
 * live metric — it rises as the ETL ingests the IRIS backlog and as recovery
 * merges land — so it must be read with its measurement date, never as a
 * constant of the data.
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

/** `availability` answers "how do I know this?", so it sits next to the source.
 *
 *  Shared by the Dashboard header, the Digital Twin tab, and the executive
 *  summary — three places that were each interpolating a server-supplied
 *  string straight into Thai copy, which put English enums on the page.
 *
 *  An unrecognised value is named but never embedded in the sentence: naming
 *  it is the data-quality signal, and embedding it would make the claim rest on
 *  prose the server controls. */
export function availabilityLabel(availability: string | null | undefined): string {
  if (availability === "usage-derived") return "สถานะจากข้อมูล usage · ไม่ใช่ live telemetry";
  if (availability === "available") return "ข้อมูลพร้อมใช้งาน";
  if (availability) return "สถานะข้อมูล: ไม่ทราบประเภทของแหล่งข้อมูล";
  return "ยังไม่มีสถานะข้อมูล";
}

// ---------------------------------------------------------------------------
// Branch sorting
// ---------------------------------------------------------------------------

export type BranchSortId = "name" | "cycles" | "running" | "utilization" | "revenue";

export type SortableBranch = {
  branchId: string;
  branchName: string;
  revenueSatang: number | null;
  cycles: number;
  machines: number;
  running: number;
};

/**
 * Orders the branch grid.
 *
 * A manager with twenty branches must otherwise read every card to find the one
 * that matters. `name` is the default because it is the only ordering that is
 * correct regardless of which measure the reader trusts.
 *
 * A redacted revenue (`null` — withheld by grant, not absent) sorts last under
 * `revenue`, never as zero: a branch the technician may not see the money for is
 * not the branch with no money.
 */
export function sortBranches<T extends SortableBranch>(branches: T[], sort: BranchSortId): T[] {
  const byName = (a: T, b: T) => a.branchName.localeCompare(b.branchName, "th");

  if (sort === "name") return [...branches].sort(byName);
  if (sort === "revenue") {
    return [...branches].sort((a, b) => {
      if (a.revenueSatang === null && b.revenueSatang === null) return byName(a, b);
      if (a.revenueSatang === null) return 1;
      if (b.revenueSatang === null) return -1;
      return b.revenueSatang - a.revenueSatang || byName(a, b);
    });
  }

  return [...branches].sort((a, b) => {
    if (sort === "cycles") return b.cycles - a.cycles || byName(a, b);
    if (sort === "running") return b.running - a.running || byName(a, b);
    // Utilization is a ratio, so it is compared as one rather than by numerator:
    // 1 of 4 and 9 of 12 are the same 25%, and the numerator alone would rank
    // the smaller floor first.
    const ratioA = a.machines > 0 ? a.running / a.machines : -1;
    const ratioB = b.machines > 0 ? b.running / b.machines : -1;
    return ratioB - ratioA || byName(a, b);
  });
}

/** The label naming what a sort is ordered by, next to the control. */
export const BRANCH_SORT_LABELS: Record<BranchSortId, string> = {
  name: "ชื่อสาขา",
  cycles: "รอบซักมากที่สุด",
  running: "รายการสถานะมากที่สุด",
  utilization: "สัดส่วนกำลังใช้งานสูงสุด",
  revenue: "รายได้มากที่สุด"
};

// ---------------------------------------------------------------------------
// Prior-period comparison
// ---------------------------------------------------------------------------

/**
 * The immediately preceding window of equal length, ending the day before the
 * selected one.
 *
 * Strictly arithmetic, never a model: AGENTS.md constrains seasonal and GBM
 * claims, and this makes none. It is also bounded by the same 90-day range
 * limit the API enforces, so the caller must check `isComparisonAvailable`
 * before asking for a window the server would reject.
 */
export function priorPeriod(range: { from: string; to: string }): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to)) return null;

  const from = new Date(`${range.from}T00:00:00Z`);
  const to = new Date(`${range.to}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return null;

  const spanDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const priorTo = new Date(from.getTime() - 86_400_000);
  const priorFrom = new Date(priorTo.getTime() - (spanDays - 1) * 86_400_000);
  if (priorFrom.getUTCFullYear() < 1970) return null;

  return { from: isoDate(priorFrom), to: isoDate(priorTo) };
}

function isoDate(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export const MAX_RANGE_DAYS = 90;

/** The API rejects a range longer than 90 days, so the combined request of two
 *  equal windows must be checked before it is made. */
export function isComparisonAvailable(prior: { from: string; to: string } | null, range: { from: string; to: string }): boolean {
  if (!prior) return false;
  const selected = new Date(`${range.from}T00:00:00Z`);
  const earliest = new Date(`${prior.from}T00:00:00Z`);
  if (Number.isNaN(selected.getTime()) || Number.isNaN(earliest.getTime())) return false;

  const spanDays = Math.round((selected.getTime() - earliest.getTime()) / 86_400_000) + 1;
  return spanDays <= MAX_RANGE_DAYS * 2;
}

export type Comparison =
  | { kind: "unavailable"; reason: string }
  | { kind: "changed"; direction: "up" | "down"; label: string; delta: string }
  | { kind: "flat"; label: string };

/**
 * The change from the prior period for one measure.
 *
 * Only ever a subtraction of two measured totals. Three states, because the two
 * that look identical are not: a prior zero makes a percentage undefined (not
 * "infinite growth"), and a missing or redacted current value is unknown, not
 * unchanged.
 */
export function priorPeriodDelta(input: {
  current: number | null;
  prior: number | null;
  label: string;
  formatNumber?: (value: number) => string;
}): Comparison {
  const format = input.formatNumber ?? ((value: number) => value.toLocaleString("th-TH"));
  const { current, prior, label } = input;

  if (current === null || prior === null || !Number.isFinite(current) || !Number.isFinite(prior)) {
    return { kind: "unavailable", reason: `${label} · ไม่มียอดก่อนหน้าให้เทียบ` };
  }
  if (prior === 0) {
    return { kind: "unavailable", reason: `${label} · ช่วงก่อนหน้าเป็นศูนย์ จึงคิดเปอร์เซ็นต์ไม่ได้` };
  }
  if (current === prior) return { kind: "flat", label: `${label} · เท่ากับช่วงก่อนหน้า` };

  const rounded = Math.round(((current - prior) / prior) * 100);
  const magnitude = `${Math.abs(rounded).toLocaleString("th-TH")}%`;
  const up = rounded > 0;
  return {
    kind: "changed",
    direction: up ? "up" : "down",
    label: `${label} · ${up ? "สูงขึ้น" : "ลดลง"} ${magnitude}`,
    delta: magnitude
  };
}
