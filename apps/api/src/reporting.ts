import type { IrisDashboard, IrisLiveMachine } from "./iris-read-client";

export type DashboardProjection = Omit<IrisDashboard, "branches" | "totals"> & {
  branches: Array<
    Omit<IrisDashboard["branches"][number], "kpi"> & {
      kpi: Omit<IrisDashboard["branches"][number]["kpi"], "revenueSatang"> & { revenueSatang: number | null };
    }
  >;
  totals: Omit<IrisDashboard["totals"], "revenueSatang"> & { revenueSatang: number | null };
};

export function redactDashboardRevenue(dashboard: IrisDashboard, mayViewRevenue: boolean): DashboardProjection {
  if (mayViewRevenue) return dashboard;

  return {
    ...dashboard,
    branches: dashboard.branches.map((item) => ({
      ...item,
      kpi: { ...item.kpi, revenueSatang: null }
    })),
    totals: { ...dashboard.totals, revenueSatang: null }
  };
}

export function buildThaiStakeholderSummary(input: {
  dashboard: DashboardProjection;
  machines: IrisLiveMachine[];
  openAlertCount: number;
}) {
  const fragments = [
    `รอบรายงานนี้มี ${input.dashboard.totals.cycles} รอบ จาก ${input.dashboard.totals.machineCount} เครื่อง`
  ];

  if (input.dashboard.totals.revenueSatang !== null) {
    fragments.push(`ยอดชำระสำเร็จ ฿${formatBaht(input.dashboard.totals.revenueSatang)}`);
  }

  const unavailable = input.machines.filter((machine) => machine.freshness === "unavailable").length;
  const stale = input.machines.filter((machine) => machine.freshness === "stale").length;
  if (input.openAlertCount > 0) fragments.push(`มี ${input.openAlertCount} รายการที่ต้องติดตาม`);
  if (unavailable > 0) fragments.push(`ข้อมูลสดไม่พร้อม ${unavailable} เครื่อง`);
  else if (stale > 0) fragments.push(`ข้อมูลสดล่าช้า ${stale} เครื่อง`);
  else if (input.machines.length > 0) fragments.push(`สถานะสดพร้อมใช้งาน ${input.machines.length} เครื่อง`);
  else fragments.push("ยังไม่มีเครื่องที่รายงานสถานะสด");

  return `${fragments.join(" · ")}.`;
}

function formatBaht(satang: number) {
  return new Intl.NumberFormat("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(satang / 100);
}
