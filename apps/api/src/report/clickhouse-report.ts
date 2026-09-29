import { createClickHouseClient, type ClickHouseExecutor } from "../analytics/clickhouse";
import { isDemoModeEnabled } from "../demo-read-client";
import type { Principal } from "../access-store";

// ---------------------------------------------------------------------------
// ClickHouse table shapes (readonly references for query typing)
// ---------------------------------------------------------------------------
type MachineUsageRow = {
  tenant_id: string;
  branch_id: string;
  machine_id: string;
  branch_name: string;
  machine_code: string;
  machine_kind: string;
  revenueSatang: string;
  cycles: string;
  attributedCycles: string;
  usageRows: string;
  started_at: string;
  last_active_at: string;
};

type BranchRow = {
  branch_id: string;
  branch_name: string;
  timezone: string;
  active: string | number;
};

type MachineStateRow = {
  tenant_id?: string;
  machine_id: string;
  branch_id: string;
  machine_code: string;
  machine_kind: string;
  branch_name: string;
  status: string | null;
  last_active_at: string | null;
  cycle_count: string | number;
};

export function buildBranchSQL(): string {
  return `
SELECT branch_id, branch_name, timezone, active
FROM dim_branch FINAL
WHERE active = 1
  AND ({branchId:String} = '' OR toString(branch_id) = {branchId:String})
GROUP BY tenant_id, branch_id, branch_name, timezone, active
ORDER BY branch_name`;
}

/**
 * Dashboard aggregation, one row per (tenant, branch, machine).
 *
 * `cycles` counts usage ROWS in the paid/finished statuses — the canonical
 * definition decided 2026-09-29 and recorded in
 * docs/04_traceability/RTM_matrix.md ("Canonical cycle definition"). It was
 * `uniqExactIf(machine_session_id, status IN (2, 4))` before that.
 *
 * Why rows and not sessions: `machine_session_id` is `Nullable(String)` and is
 * NULL on 63.91% of real usage rows (2,849 of 4,458, 2026-07-22 → 2026-09-25),
 * so a distinct-session count silently dropped two thirds of the work — the
 * real warehouse's ฿16,480,000 revenue over 1,314 such "cycles" is ฿125.42
 * each, about three times a real Thai wash, while the same revenue over 3,905
 * rows is ฿42.20. The cardinality diagnostic
 * (`apps/api/scripts/cycle-cardinality-diagnostic.ts`) measured that one real
 * session id spans exactly one row and exactly one status, so for attributed
 * rows the two definitions are identical; the divergence was entirely the
 * missing attribution. `status IN (2, 4)` is a data-contract decision
 * (docs/03_data_contracts/data_contracts.md) and is unchanged.
 *
 * The gap is still measured rather than assumed away: `attributedCycles`
 * counts how many of the counted rows carry a non-null `machine_session_id`,
 * which is what `cycleAttribution` surfaces. Revenue is untouched — it is
 * separately correct and separately verified.
 */
export function buildDashboardSQL(): string {
  return `
SELECT
  u.tenant_id AS tenant_id,
  u.branch_id AS branch_id,
  u.machine_id AS machine_id,
  b.branch_name AS branch_name,
  m.machine_code AS machine_code,
  m.machine_kind AS machine_kind,
  sumIf(u.amount_satang, u.status IN (2, 4)) AS revenueSatang,
  countIf(u.status IN (2, 4)) AS cycles,
  countIf(u.status IN (2, 4) AND u.machine_session_id IS NOT NULL) AS attributedCycles,
  count() AS usageRows,
  max(u.started_at) AS last_active_at
FROM fact_machine_usage AS u FINAL
INNER JOIN dim_branch AS b FINAL ON u.tenant_id = b.tenant_id AND u.branch_id = b.branch_id
INNER JOIN dim_machine AS m FINAL ON u.tenant_id = m.tenant_id AND u.branch_id = m.branch_id AND u.machine_id = m.machine_id
WHERE u.started_at >= {from:String}
  AND u.started_at < plus(toDate({to:String}), 1)
  AND ({branchId:String} = '' OR toString(u.branch_id) = {branchId:String})
GROUP BY u.tenant_id, u.branch_id, u.machine_id, b.branch_name, m.machine_code, m.machine_kind`;
}

export function buildMachineStateSQL(): string {
  return `
SELECT
  m.tenant_id AS tenant_id,
  m.machine_id AS machine_id,
  m.branch_id AS branch_id,
  b.branch_name AS branch_name,
  m.machine_code AS machine_code,
  m.machine_kind AS machine_kind,
  argMax(u.status, u.started_at) AS status,
  max(u.started_at) AS last_active_at,
  countIf(u.status IN (2, 4)) AS cycle_count
FROM dim_machine AS m FINAL
INNER JOIN dim_branch AS b FINAL ON m.tenant_id = b.tenant_id AND m.branch_id = b.branch_id
LEFT JOIN fact_machine_usage AS u FINAL ON
  m.tenant_id = u.tenant_id
  AND m.branch_id = u.branch_id
  AND m.machine_id = u.machine_id
  AND u.started_at >= {from:String}
  AND u.started_at < plus(toDate({to:String}), 1)
WHERE m.active = 1
  AND b.active = 1
  AND ({branchId:String} = '' OR toString(m.branch_id) = {branchId:String})
GROUP BY m.tenant_id, m.branch_id, m.machine_id, b.branch_name, m.machine_code, m.machine_kind
ORDER BY last_active_at DESC
SETTINGS join_use_nulls = 1`;
}

export type BranchInfo = {
  branchId: string;
  branchName: string;
  timezone: string;
  active: boolean;
};

// Mirrors fact_machine_usage.status (apps/etl/src/schema.ts) plus the
// presentation-only `idle`/`offline` states. `finished` and `paid` stay
// separate members: docs/06_ml/ml-training-data-guide.md defines a
// paid_ratio over both, and collapsing them made that ratio meaningless.
export type MachineStatus =
  | "running"
  | "paid"
  | "finished"
  | "cancelled"
  | "admitted"
  | "pending"
  | "idle"
  | "offline"
  | "unknown";

export type MachineInfo = {
  tenantId: string;
  machineId: string;
  branchId: string;
  machineCode: string;
  machineKind: "washer" | "dryer";
  branchName: string;
  status: MachineStatus;
  lastActiveAt: string | null;
  cycleCount: number | null;
  /** Which definition `cycleCount` was taken from. It is NOT `machine_session_id`:
   *  the count is `countIf(status IN (2, 4))` over usage rows, the canonical
   *  definition, so labelling it by that nullable field would misdescribe it. */
  cycleCountSource: "usage_row" | "unavailable";
};

/** How much of the dashboard `cycles` count rests on a `machine_session_id`.
 *  `countedRows` is the denominator the KPI is computed over, and
 *  `attributedRows` is how many of those rows carry the field. The difference
 *  is a real, measured gap, not a rounding artifact: on the production
 *  warehouse 63.91% of usage rows have no session id, so a reader who is not
 *  told this will read a row count as a fully attributed session count. */
export type CycleAttribution = {
  countedRows: number;
  attributedRows: number;
  unattributedRows: number;
};

export type DashboardTotals = {
  revenueSatang: number | null;
  cycles: number;
  machines: number;
  running: number;
};

export type DashboardBranch = {
  branchId: string;
  branchName: string;
  revenueSatang: number | null;
  cycles: number;
  machines: number;
  running: number;
};

export type DashboardData = {
  from: string;
  to: string;
  source: "clickhouse" | "demo";
  /** Presence signal: usage rows in range inside the resolved branch scope.
   *  0 proves "no usage at all in this window"; a positive value is the number
   *  of usage rows, not the number of machine/status groups they aggregate into.
   *  `null` means the source cannot count usage rows (the IRIS/demo projection
   *  has no such field), so presence is unknown and must not be presented as
   *  either empty or populated. */
  usageRowsInRange: number | null;
  /** How much of `totals.cycles` carries a `machine_session_id`. Additive in
   *  the same sense as `usageRowsInRange`: always present on the ClickHouse
   *  path (including as a zeroed measurement for an empty window), and `null`
   *  on the IRIS/demo path, which cannot measure attribution at all. A `null`
   *  here means the gap is unknown — never that the gap is zero. */
  cycleAttribution: CycleAttribution | null;
  totals: DashboardTotals;
  branches: DashboardBranch[];
};

// ---------------------------------------------------------------------------
// Query functions (all async — ClickHouse returns Promise)
// ---------------------------------------------------------------------------

function isFreshUsage(lastActiveAt: string | null): boolean {
  if (!lastActiveAt) return false;
  const age = Date.now() - new Date(lastActiveAt).getTime();
  return Number.isFinite(age) && age >= 0 && age <= 30 * 60 * 1000;
}

export async function queryBranches(ch: ClickHouseExecutor, branchId?: string): Promise<BranchInfo[]> {
  const rows = await ch<BranchRow>(buildBranchSQL(), { branchId: branchId ?? "" });
  return rows.map((r) => ({
    branchId: r.branch_id,
    branchName: r.branch_name,
    timezone: r.timezone,
    active: r.active === "1" || r.active === 1
  }));
}

export async function queryDashboard(
  ch: ClickHouseExecutor,
  from: string,
  to: string,
  branchId?: string
): Promise<DashboardData> {
  const [rows, currentStates] = await Promise.all([
    ch<MachineUsageRow>(buildDashboardSQL(), { from, to, branchId: branchId ?? "" }),
    queryMachineStates(ch, to, to, branchId)
  ]);

  const branchMap = new Map<
    string,
    { branchId: string; branchName: string; revenueSatang: number; cycles: number; machines: Set<string>; running: number }
  >();
  let totalRevenue = 0;
  let totalCycles = 0;
  const machines = new Set<string>();
  let attributedCycles = 0;

  for (const state of currentStates) {
    const branchKey = `${state.tenantId}:${state.branchId}`;
    const machineKey = `${branchKey}:${state.machineId}`;
    machines.add(machineKey);
    const current = branchMap.get(branchKey) ?? {
      branchId: state.branchId,
      branchName: state.branchName,
      revenueSatang: 0,
      cycles: 0,
      machines: new Set<string>(),
      running: 0
    };
    current.machines.add(machineKey);
    if (state.status === "running" && isFreshUsage(state.lastActiveAt)) current.running += 1;
    branchMap.set(branchKey, current);
  }

  for (const r of rows) {
    const branchKey = `${r.tenant_id}:${r.branch_id}`;
    const machineKey = `${branchKey}:${r.machine_id}`;
    machines.add(machineKey);
    const rev = Number(r.revenueSatang) || 0;
    const cyc = Number(r.cycles) || 0;
    totalRevenue += rev;
    totalCycles += cyc;
    attributedCycles += Number(r.attributedCycles) || 0;

    const existing = branchMap.get(branchKey) ?? {
      branchId: r.branch_id,
      branchName: r.branch_name,
      revenueSatang: 0,
      cycles: 0,
      machines: new Set<string>(),
      running: 0
    };
    existing.revenueSatang += rev;
    existing.cycles += cyc;
    existing.machines.add(machineKey);
    branchMap.set(branchKey, existing);
  }

  return {
    from,
    to,
    source: "clickhouse",
    usageRowsInRange: rows.reduce((total, r) => total + (Number(r.usageRows) || 0), 0),
    // Attribution is measured over the same rows the KPI counts, so
    // `unattributedRows` is exactly the number of cycles with no session id
    // behind them. A `Math.max(0, …)` guard is deliberate: it keeps an
    // inconsistent pair from reporting a negative gap, which would read as
    // more attributed rows than there are counted rows.
    cycleAttribution: {
      countedRows: totalCycles,
      attributedRows: attributedCycles,
      unattributedRows: Math.max(0, totalCycles - attributedCycles)
    },
    totals: {
      revenueSatang: totalRevenue,
      cycles: totalCycles,
      machines: machines.size,
      running: Array.from(branchMap.values()).reduce((total, branch) => total + branch.running, 0)
    },
    branches: Array.from(branchMap.values()).map((b) => ({
      branchId: b.branchId,
      branchName: b.branchName,
      revenueSatang: b.revenueSatang,
      cycles: b.cycles,
      machines: b.machines.size,
      running: b.running
    }))
  };
}

export async function queryMachineStates(
  ch: ClickHouseExecutor,
  from: string,
  to: string,
  branchId?: string
): Promise<MachineInfo[]> {
  const rows = await ch<MachineStateRow>(buildMachineStateSQL(), { from, to, branchId: branchId ?? "" });

  const statusMap: Record<string, MachineInfo["status"]> = {
    running: "running",
    paid: "paid",
    pending_payment: "pending",
    // `finished` and `paid` are separate fact_machine_usage enum members and
    // stay separate here. The exact upstream difference is still unresolved —
    // see docs/03_data_contracts/data_contracts.md.
    finished: "finished",
    cancelled: "cancelled",
    admitted: "admitted",
    idle: "idle"
  };

  return rows.map((r: MachineStateRow) => {
    const countedCycles = Number(r.cycle_count) || 0;
    const cycleCount = countedCycles > 0 ? countedCycles : null;
    return {
      tenantId: r.tenant_id ?? "unknown",
      machineId: r.machine_id,
      branchId: r.branch_id,
      machineCode: r.machine_code,
      machineKind: r.machine_kind as "washer" | "dryer",
      branchName: r.branch_name,
      status: statusMap[r.status ?? ""] ?? "unknown",
      lastActiveAt: r.last_active_at || null,
      cycleCount,
      cycleCountSource: cycleCount === null ? "unavailable" : "usage_row"
    };
  });
}
