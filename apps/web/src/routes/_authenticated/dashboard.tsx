import { createFileRoute } from "@tanstack/react-router";
import { Card, Chip } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiUrl } from "../../lib/api/client";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage
});

type ApiDashboard = {
  from: string;
  to: string;
  source: "clickhouse" | "demo";
  totals: { revenueSatang: number; cycles: number; machines: number; running: number };
  branches: Array<{
    branchId: string;
    branchName: string;
    revenueSatang: number;
    cycles: number;
    machines: number;
    running: number;
  }>;
};

function baht(satang: number): string {
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency: "THB",
    maximumFractionDigits: 0
  }).format(satang / 100);
}

function DashboardPage() {
  const [view, setView] = useState<"dashboard" | "twin">("dashboard");

  const dashQuery = useQuery({
    queryKey: ["report", "dashboard"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/report/dashboard"), { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { dashboard: ApiDashboard };
    }
  });

  const twinQuery = useQuery({
    queryKey: ["twin", "machines"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/twin"), { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { machines: Array<{ machineCode: string; machineKind: string; branchName: string; status: string; lastActiveAt: string | null }> };
    },
    refetchInterval: 30000
  });

  const isLoading = dashQuery.isLoading || twinQuery.isLoading;

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <div className="text-large font-semibold text-default-400 animate-pulse">กำลังโหลดข้อมูล…</div>
      </div>
    );
  }

  const dashData = dashQuery.data?.dashboard;
  const twinData = twinQuery.data?.machines ?? [];

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">LaundroTwin</h1>
          <p className="text-sm text-default-400 mt-1">
            ระบบจัดการและวิเคราะห์การซักผ้าแบบดิจิทัล
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setView("dashboard")}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${view === "dashboard" ? "bg-primary text-primary-foreground" : "bg-default-100 text-default-700 hover:bg-default-200"}`}
          >
            📊 แดชบอร์ด
          </button>
          <button
            onClick={() => setView("twin")}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${view === "twin" ? "bg-primary text-primary-foreground" : "bg-default-100 text-default-700 hover:bg-default-200"}`}
          >
            🤖 Digital Twin
          </button>
        </div>
      </div>

      {view === "dashboard" && dashData && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard icon="💰" label="รายได้รวม" value={baht(dashData.totals.revenueSatang)} sub={`${dashData.totals.cycles} รอบซัก`} />
            <KpiCard icon="🔄" label="รอบซัก" value={dashData.totals.cycles.toLocaleString("th-TH")} sub="7 วันที่ผ่านมา" />
            <KpiCard icon="🖥️" label="เครื่องทั้งหมด" value={dashData.totals.machines.toString()} sub={`${dashData.totals.running} เครื่องใช้งาน`} />
            <KpiCard icon="🏪" label="สาขา" value={dashData.branches.length.toString()} sub={dashData.branches[0]?.branchName ?? "—"} />
          </div>

          

          <div>
            <h2 className="mb-3 text-lg font-semibold">รายสาขา</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {dashData.branches.map((b) => (
                <BranchCard key={b.branchId} branch={b} />
              ))}
            </div>
          </div>
        </>
      )}

      {view === "twin" && (
        <div>
          <h2 className="text-lg font-semibold mb-3">สถานะเครื่องซักผ้าแบบเรียลไทม์</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {twinData.map((m) => (
              <MachineCard key={m.machineCode} machine={m} />
            ))}
          </div>
          {twinData.length === 0 && (
            <Card>
              <div className="text-center text-default-400 py-8">ไม่พบรหัสเครื่องในระบบ</div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function KpiCard({ icon, label, value, sub }: { icon: string; label: string; value: string; sub: string }) {
  return (
    <Card className="shadow-small">
      <div className="flex flex-row items-center gap-4 p-5">
        <div className="text-3xl">{icon}</div>
        <div className="flex flex-col">
          <span className="text-xs text-default-400 uppercase tracking-wide">{label}</span>
          <strong className="text-xl font-bold">{value}</strong>
          <span className="text-xs text-default-400">{sub}</span>
        </div>
      </div>
    </Card>
  );
}

function BranchCard({ branch }: { branch: ApiDashboard["branches"][0] }) {
  const utilization = branch.machines > 0 ? branch.running / branch.machines : 0;
  return (
    <Card className="shadow-small">
      <div className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-medium">{branch.branchName}</h3>
          <Chip color={branch.running > 0 ? "warning" as any : "default" as any} size="sm">{branch.running}/{branch.machines}</Chip>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div><span className="text-default-400">รายได้</span><p className="font-semibold">{baht(branch.revenueSatang)}</p></div>
          <div><span className="text-default-400">รอบซัก</span><p className="font-semibold">{branch.cycles.toLocaleString("th-TH")}</p></div>
          <div><span className="text-default-400">เครื่อง</span><p className="font-semibold">{branch.machines}</p></div>
          <div><span className="text-default-400">Utilization</span><p className="font-semibold">{Math.round(utilization * 100)}%</p></div>
        </div>
        <div className="mt-3 h-2 bg-default-100 rounded-full overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${utilization * 100}%` }} />
        </div>
      </div>
    </Card>
  );
}

function MachineCard({ machine }: { machine: { machineCode: string; machineKind: string; branchName: string; status: string; lastActiveAt: string | null } }) {
  const kindLabel = machine.machineKind === "washer" ? "ซักผ้า" : "อบผ้า";
  const statusMap: Record<string, { color: string; label: string }> = {
    running: { color: "warning" as any, label: "กำลังใช้งาน" },
    paid: { color: "success" as any, label: "ชำระแล้ว" },
    pending: { color: "default" as any, label: "รอชำระ" },
    idle: { color: "secondary" as any, label: "ว่าง" }
  };
  const s = statusMap[machine.status] ?? { color: "default" as any, label: machine.status };
  return (
    <Card className="shadow-small">
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div><span className="font-bold text-lg">{machine.machineCode}</span><span className="text-xs text-default-400 ml-2">{kindLabel}</span></div>
          <Chip color={s.color as any} size="sm">{s.label}</Chip>
        </div>
        <p className="text-xs text-default-400">{machine.branchName}</p>
        {machine.lastActiveAt && (
          <p className="text-xs text-default-300 mt-1">ใช้งานล่าสุด: {new Date(machine.lastActiveAt).toLocaleString("th-TH")}</p>
        )}
      </div>
    </Card>
  );
}