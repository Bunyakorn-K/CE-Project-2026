import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { apiUrl } from "../../lib/api/client";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage
});

type DashboardResponse = {
  contractVersion: string;
  source: string;
  fetchedAt: string;
  range: { from: string; to: string };
  branches: Array<{
    branch: { id: string; code: string; name: string; timezone: string; status: string };
    kpi: {
      revenueSatang: number;
      cycles: number;
      machineCount: number;
      totalCycleMinutes: number;
      utilization: number | null;
    };
  }>;
  totals: { revenueSatang: number; cycles: number; machineCount: number };
};

function baht(satang: number | null | undefined): string {
  if (satang === null || satang === undefined) return "—";
  return new Intl.NumberFormat("th-TH", { style: "currency", currency: "THB", maximumFractionDigits: 0 }).format(satang / 100);
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 100)}%`;
}

function DashboardPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["report", "dashboard"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/report/dashboard"), { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { dashboard: DashboardResponse };
    }
  });

  if (isLoading) {
    return <div className="text-default-500">Loading dashboard…</div>;
  }
  if (error || !data) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Card>
          <div className="p-4 text-sm text-danger">
            ไม่สามารถโหลดข้อมูลแดชบอร์ดได้: {error instanceof Error ? error.message : "unknown"}
          </div>
        </Card>
      </div>
    );
  }

  const d = data.dashboard;
  const totals = d.totals;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-default-500">
            {d.range.from} → {d.range.to} · source: {d.source}
            {d.source === "demo" ? " (ข้อมูลจำลอง)" : ""}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="รายได้รวม" value={baht(totals.revenueSatang)} />
        <KpiCard label="รอบซักรวม" value={new Intl.NumberFormat("th-TH").format(totals.cycles)} />
        <KpiCard label="เครื่องซักผ้า" value={new Intl.NumberFormat("th-TH").format(totals.machineCount)} />
        <KpiCard label="สาขา" value={String(d.branches.length)} />
      </div>

      <div>
        <h2 className="mb-2 text-lg font-semibold">รายสาขา</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {d.branches.map(({ branch, kpi }) => (
            <Card key={branch.id}>
              <div className="flex flex-col gap-2 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <strong>{branch.name}</strong>
                    <p className="text-xs text-default-400">
                      {branch.code} · {branch.timezone} · {branch.status}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <span className="text-default-500">รายได้</span>
                  <span className="text-right font-semibold">{baht(kpi.revenueSatang)}</span>
                  <span className="text-default-500">รอบซัก</span>
                  <span className="text-right font-semibold">{new Intl.NumberFormat("th-TH").format(kpi.cycles)}</span>
                  <span className="text-default-500">เครื่อง</span>
                  <span className="text-right font-semibold">{kpi.machineCount}</span>
                  <span className="text-default-500">Utilization</span>
                  <span className="text-right font-semibold">{pct(kpi.utilization)}</span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="flex flex-col gap-1 p-4">
        <span className="text-xs text-default-400">{label}</span>
        <strong className="text-xl">{value}</strong>
      </div>
    </Card>
  );
}
