import { createClickHouseClient, type ClickHouseExecutor } from "../analytics/clickhouse";
import { isDemoModeEnabled } from "../demo-read-client";
import type { Principal } from "../access-store";

// ---------------------------------------------------------------------------
// ClickHouse table shapes (readonly references for query typing)
// ---------------------------------------------------------------------------
type MachineUsageRow = {
  branch_id: string;
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
  branch_code: string;
  active: string;
};

type MachineStateRow = {
  machine_code: string;
  machine_kind: string;
  branch_name: string;
  status: string;
  last_active_at: string;
};

// ---------------------------------------------------------------------------
// Queries (dates embedded via sqlDate; no ClickHouse named params needed)
// ---------------------------------------------------------------------------

const BRANCH_SQL = `
SELECT b.branch_id, b.branch_name, b.branch_code, b.active
FROM dim_branch AS b
WHERE b.active = 1
ORDER BY b.branch_name`;

export function buildDashboardSQL(from: string, to: string): string {
  return `
SELECT b.branch_id AS branch_id, b.branch_name AS branch_name, m.machine_code AS machine_code, m.machine_kind AS machine_kind, u.status AS status, sumIf(u.amount_satang, u.status IN (2,4)) AS revenueSatang, countIf(u.status IN (2,4)) AS cycles, max(u.started_at) AS last_active_at
FROM fact_machine_usage AS u
INNER JOIN dim_branch AS b ON u.tenant_id = b.tenant_id AND u.branch_id = b.branch_id
INNER JOIN dim_machine AS m ON u.machine_id = m.machine_id
WHERE u.started_at >= '${from}' AND u.started_at < '${to}'
GROUP BY b.branch_id, b.branch_name, m.machine_code, m.machine_kind, u.status`;
}

export function buildMachineStateSQL(from: string): string {
  return `
SELECT
  u.branch_id AS branch_id,
  b.branch_name AS branch_name,
  m.machine_code AS machine_code,
  m.machine_kind AS machine_kind,
  argMax(u.status, u.started_at) AS status,
  max(u.started_at) AS last_active_at
FROM fact_machine_usage AS u
INNER JOIN dim_branch AS b ON u.tenant_id = b.tenant_id AND u.branch_id = b.branch_id
INNER JOIN dim_machine AS m ON u.machine_id = m.machine_id
WHERE u.started_at >= '${from}'
GROUP BY u.branch_id, b.branch_name, m.machine_code, m.machine_kind
ORDER BY last_active_at DESC`;
}

function sqlDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function satangToBaht(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n / 100) : null;
}

export type BranchInfo = {
  branchId: string;
  branchName: string;
  branchCode: string;
  active: boolean;
};

export type MachineStatus = "running" | "paid" | "pending" | "idle" | "offline";

export type MachineInfo = {
  machineCode: string;
  machineKind: "washer" | "dryer";
  branchName: string;
  status: MachineStatus;
  lastActiveAt: string | null;
};

export type DashboardTotals = {
  revenueSatang: number;
  cycles: number;
  machines: number;
  running: number;
};

export type DashboardBranch = {
  branchId: string;
  branchName: string;
  revenueSatang: number;
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

export async function queryBranches(ch: ClickHouseExecutor): Promise<BranchInfo[]> {
  const rows = await ch<BranchRow>(BRANCH_SQL, {});
  return rows.map((r) => ({
    branchId: r.branch_id,
    branchName: r.branch_name,
    branchCode: r.branch_code,
    active: r.active === "1"
  }));
}

export async function queryDashboard(
  ch: ClickHouseExecutor,
  from: string,
  to: string
): Promise<DashboardData> {
  const normalizeDate = (d: string) => d.slice(0, 10);
  const sql = buildDashboardSQL(normalizeDate(from), normalizeDate(to));
  const rows = await ch<MachineUsageRow>(sql, {});

  const branchMap = new Map<
    string,
    { branchId: string; branchName: string; revenueSatang: number; cycles: number; machineCodes: Set<string>; running: number }
  >();
  let totalRevenue = 0;
  let totalCycles = 0;
  const machineSet = new Set<string>();
  let running = 0;

  for (const r of rows) {
    machineSet.add(r.machine_code);
    if (r.status === "running") running++;
    const rev = Number(r.revenueSatang) || 0;
    const cyc = Number(r.cycles) || 0;
    totalRevenue += rev;
    totalCycles += cyc;

    const existing = branchMap.get(r.branch_id);
    if (existing) {
      existing.revenueSatang += rev;
      existing.cycles += cyc;
      existing.machineCodes.add(r.machine_code);
      if (r.status === "running") existing.running++;
    } else {
      branchMap.set(r.branch_id, {
        branchId: r.branch_id,
        branchName: r.branch_name,
        revenueSatang: rev,
        cycles: cyc,
        machineCodes: new Set([r.machine_code]),
        running: r.status === "running" ? 1 : 0
      });
    }
  }

  return {
    from,
    to,
    source: "clickhouse",
    totals: {
      revenueSatang: totalRevenue,
      cycles: totalCycles,
      machines: machineSet.size,
      running
    },
    branches: Array.from(branchMap.values()).map((b) => ({
      branchId: b.branchId,
      branchName: b.branchName,
      revenueSatang: b.revenueSatang,
      cycles: b.cycles,
      machines: b.machineCodes.size,
      running: b.running
    }))
  };
}

export async function queryMachineStates(
  ch: ClickHouseExecutor,
  from: string
): Promise<MachineInfo[]> {
  const normalizeDate = (d: string) => d.slice(0, 10);
  const sql = buildMachineStateSQL(normalizeDate(from));
  const rows = await ch<MachineStateRow>(sql, {});

  const statusMap: Record<string, MachineInfo["status"]> = {
    running: "running",
    paid: "paid",
    pending_payment: "pending",
    finished: "paid",
    cancelled: "idle",
    admitted: "idle",
    idle: "idle"
  };

  return rows.map((r: MachineStateRow) => ({
    machineCode: r.machine_code,
    machineKind: r.machine_kind as "washer" | "dryer",
    branchName: r.branch_name,
    status: (statusMap[r.status] || "idle") as MachineInfo["status"],
    lastActiveAt: r.last_active_at || null
  }));
}
