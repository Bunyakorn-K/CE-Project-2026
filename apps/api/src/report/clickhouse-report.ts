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
  status: string;
  revenueSatang: string;
  cycles: string;
  started_at: string;
  last_active_at: string;
};

type BranchRow = {
  branch_id: string;
  branch_name: string;
  branch_code: string | null;
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
SELECT branch_id, branch_name, branch_code, timezone, active
FROM dim_branch FINAL
WHERE active = 1
  AND ({branchId:String} = '' OR toString(branch_id) = {branchId:String})
GROUP BY tenant_id, branch_id, branch_name, branch_code, timezone, active
ORDER BY branch_name`;
}

export function buildDashboardSQL(): string {
  return `
SELECT
  u.tenant_id AS tenant_id,
  u.branch_id AS branch_id,
  u.machine_id AS machine_id,
  b.branch_name AS branch_name,
  m.machine_code AS machine_code,
  m.machine_kind AS machine_kind,
  u.status AS status,
  sumIf(u.amount_satang, u.status IN (2, 4)) AS revenueSatang,
  uniqExactIf(u.machine_session_id, u.status IN (2, 4)) AS cycles,
  max(u.started_at) AS last_active_at
FROM fact_machine_usage AS u FINAL
INNER JOIN dim_branch AS b FINAL ON u.tenant_id = b.tenant_id AND u.branch_id = b.branch_id
INNER JOIN dim_machine AS m FINAL ON u.tenant_id = m.tenant_id AND u.branch_id = m.branch_id AND u.machine_id = m.machine_id
WHERE u.started_at >= {from:String}
  AND u.started_at < plus(toDate({to:String}), 1)
  AND ({branchId:String} = '' OR toString(u.branch_id) = {branchId:String})
GROUP BY u.tenant_id, u.branch_id, u.machine_id, b.branch_name, m.machine_code, m.machine_kind, u.status`;
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
  countDistinct(u.machine_session_id) AS cycle_count
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
  branchCode: string | null;
  timezone: string;
  active: boolean;
};

export type MachineStatus = "running" | "paid" | "pending" | "idle" | "offline" | "unknown";

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
  cycleCountSource: "machine_session_id" | "unavailable";
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
    branchCode: r.branch_code,
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
    finished: "paid",
    idle: "idle"
  };

  return rows.map((r: MachineStateRow) => {
    const sessionCycles = Number(r.cycle_count) || 0;
    const cycleCount = sessionCycles > 0 ? sessionCycles : null;
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
      cycleCountSource: cycleCount === null ? "unavailable" : "machine_session_id"
    };
  });
}
