import { createFileRoute } from "@tanstack/react-router";
import { Card, Tabs } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiErrorMessage, apiUrl } from "../../lib/api/client";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage
});

type Source = "clickhouse" | "demo";
type Availability = "usage-derived" | "available" | string;

type DashboardData = {
  from: string;
  to: string;
  source: Source;
  totals: {
    revenueSatang: number | null;
    cycles: number;
    machines: number;
    running: number;
  };
  branches: Array<{
    branchId: string;
    branchName: string;
    revenueSatang: number | null;
    cycles: number;
    machines: number;
    running: number;
  }>;
};

type DashboardEnvelope = {
  source: Source;
  fetchedAt: string;
  range: { from: string; to: string };
  availability: Availability;
  dashboard: DashboardData;
};

type TwinEnvelope = {
  source: Source;
  fetchedAt: string;
  range: { from: string; to: string };
  availability: Availability;
  from: string;
  to: string;
  machines: Machine[];
};

type Machine = {
  machineId?: string;
  machineCode: string;
  machineKind: string;
  branchId?: string;
  branchName: string;
  status: string | null;
  lastActiveAt: string | null;
  cycleCount: number | null;
  cycleCountSource?: "machine_session_id" | "unavailable";
};

type Branch = { id: string; name: string };
type DashboardView = "dashboard" | "twin";

function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function recentRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(to.getDate() - 6);
  return { from: localDate(from), to: localDate(to) };
}

function reportPath(path: string, from: string, to: string, branchId: string): string {
  const query = new URLSearchParams({ from, to });
  if (branchId) query.set("branchId", branchId);
  return `${path}?${query.toString()}`;
}

async function fetchJson<T>(path: string, fallback: string): Promise<T> {
  const response = await fetch(apiUrl(path), { credentials: "include" });
  if (!response.ok) throw new Error(await apiErrorMessage(response, `${fallback} (HTTP ${response.status})`));
  return (await response.json()) as T;
}

function baht(satang: number): string {
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency: "THB",
    maximumFractionDigits: 0
  }).format(satang / 100);
}

function formatDate(value: string): string {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" });
}

function formatDateTime(value: string | null): string {
  if (!value) return "ไม่มีเวลาดึงข้อมูล";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("th-TH", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function sourceLabel(source: Source | null): string {
  if (source === "clickhouse") return "แหล่งข้อมูล: ClickHouse";
  if (source === "demo") return "โหมด Demo · ข้อมูลจำลอง";
  return "กำลังรอข้อมูลแหล่งที่มา";
}

function availabilityLabel(availability: Availability | null): string {
  if (availability === "usage-derived") return "สถานะจากข้อมูล usage · ไม่ใช่ live telemetry";
  if (availability === "available") return "ข้อมูลพร้อมใช้งาน";
  if (availability) return `สถานะข้อมูล: ${availability}`;
  return "ยังไม่มีสถานะข้อมูล";
}

function statusMeta(status: string | null): { label: string; className: string } {
  const statuses: Record<string, { label: string; className: string }> = {
    running: { label: "กำลังใช้งาน", className: "status-pill--success" },
    washing: { label: "กำลังซัก", className: "status-pill--success" },
    drying: { label: "กำลังอบ", className: "status-pill--success" },
    paid: { label: "ชำระแล้ว", className: "status-pill--warning" },
    pending: { label: "รอชำระ", className: "status-pill--warning" },
    idle: { label: "ว่าง", className: "status-pill--neutral" },
    offline: { label: "ออฟไลน์", className: "status-pill--danger" },
    unknown: { label: "ไม่ทราบสถานะ", className: "status-pill--neutral" }
  };
  return statuses[status ?? ""] ?? { label: "ไม่ทราบสถานะ", className: "status-pill--neutral" };
}

function machineKindLabel(kind: string): string {
  if (kind === "washer") return "เครื่องซักผ้า";
  if (kind === "dryer") return "เครื่องอบผ้า";
  return kind || "ไม่ระบุประเภท";
}

function DashboardPage() {
  const [view, setView] = useState<DashboardView>("dashboard");
  const [branchId, setBranchId] = useState("");
  const [range, setRange] = useState(recentRange);
  const validRange = Boolean(range.from && range.to && range.from <= range.to);

  const branchesQuery = useQuery({
    queryKey: ["report", "branches", "dashboard-filters"],
    queryFn: () => fetchJson<{ branches: Branch[] }>("/api/report/branches", "ไม่สามารถโหลดรายชื่อสาขาได้")
  });

  const dashQuery = useQuery({
    queryKey: ["report", "dashboard", branchId, range.from, range.to],
    queryFn: () => fetchJson<DashboardEnvelope>(reportPath("/api/report/dashboard", range.from, range.to, branchId), "ไม่สามารถโหลดแดชบอร์ดได้"),
    enabled: validRange
  });

  const twinQuery = useQuery({
    queryKey: ["twin", "dashboard", branchId, range.from, range.to],
    queryFn: () => fetchJson<TwinEnvelope>(reportPath("/api/twin", range.from, range.to, branchId), "ไม่สามารถโหลด Digital Twin ได้"),
    enabled: validRange && view === "twin",
    refetchInterval: 60000
  });

  const dashData = dashQuery.data?.dashboard;
  const twinData = twinQuery.data;
  const activeSource = view === "twin" ? twinData?.source ?? null : dashQuery.data?.source ?? null;
  const activeAvailability = view === "twin" ? twinData?.availability ?? null : dashQuery.data?.availability ?? null;
  const activeRange = view === "twin" ? twinData?.range ?? null : dashQuery.data?.range ?? null;
  const activeFetchedAt = view === "twin" ? twinData?.fetchedAt ?? null : dashQuery.data?.fetchedAt ?? null;

  return (
    <div className="page-content">
      <Tabs
        className="page-tabs"
        selectedKey={view}
        onSelectionChange={(key) => {
          const nextView = String(key);
          if (nextView === "dashboard" || nextView === "twin") setView(nextView);
        }}
      >
        <section className="surface-card surface-card--dark">
          <div className="page-header">
            <div>
              <h1>ภาพรวมการดำเนินงาน</h1>
              <p>ติดตามผลประกอบการและหลักฐานสถานะเครื่องในช่วงเวลาที่เลือก</p>
              <div className="data-context header-data-context" aria-live="polite">
                <span className="source-pill">{sourceLabel(activeSource)}</span>
                <span>{availabilityLabel(activeAvailability)}</span>
                {activeRange && <strong>{formatDate(activeRange.from)} — {formatDate(activeRange.to)}</strong>}
                <span>ดึงเมื่อ {formatDateTime(activeFetchedAt)}</span>
              </div>
            </div>
            <Tabs.ListContainer className="view-tabs-container">
              <Tabs.List className="view-switcher" aria-label="เลือกมุมมอง">
                <Tabs.Tab id="dashboard">ภาพรวม<Tabs.Indicator /></Tabs.Tab>
                <Tabs.Tab id="twin">Digital Twin<Tabs.Indicator /></Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
          </div>
        </section>

        <section className="filter-panel" aria-label="ตัวกรองข้อมูล">
          <div className="filter-field filter-field--branch">
            <label htmlFor="dashboard-branch">สาขา</label>
            <select
              id="dashboard-branch"
              value={branchId}
              disabled={branchesQuery.isLoading}
              onChange={(event) => setBranchId(event.target.value)}
            >
              <option value="">ทุกสาขาที่มีสิทธิ์</option>
              {(branchesQuery.data?.branches ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor="dashboard-from">ตั้งแต่วันที่</label>
            <input id="dashboard-from" type="date" value={range.from} max={range.to} onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))} />
          </div>
          <div className="filter-field">
            <label htmlFor="dashboard-to">ถึงวันที่</label>
            <input id="dashboard-to" type="date" value={range.to} min={range.from} onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))} />
          </div>
          <p className="filter-note" role="status">วันที่ใช้รูปแบบ YYYY-MM-DD และส่งขอบเขตสาขาไปยังเซิร์ฟเวอร์</p>
        </section>

        <Tabs.Panel id="dashboard" className="dashboard-panel">
          {!validRange && <div className="error-message">เลือกช่วงวันที่ให้ถูกต้องก่อนโหลดข้อมูล</div>}
          {branchesQuery.isError && <div className="error-message" role="alert">ไม่สามารถโหลดรายชื่อสาขาได้: {branchesQuery.error.message}</div>}
          {dashQuery.isLoading && <div className="loading-state compact" role="status" aria-live="polite"><span className="loading-orbit" />กำลังโหลดข้อมูลแดชบอร์ด</div>}
          {dashQuery.isError && (
            <div className="error-message" role="alert">
              <span>ไม่สามารถโหลดข้อมูลแดชบอร์ดได้: {dashQuery.error.message}</span>
              <button type="button" className="secondary-button" onClick={() => void dashQuery.refetch()}>ลองใหม่</button>
            </div>
          )}
          {dashData && (
            <>
              <section className="kpi-grid" aria-label="ตัวชี้วัดหลัก">
                <KpiCard
                  label="รายได้รวม"
                  value={dashData.totals.revenueSatang === null ? "ไม่พร้อมใช้งาน" : baht(dashData.totals.revenueSatang)}
                  detail={dashData.totals.revenueSatang === null ? "ไม่มีสิทธิ์ดูรายได้" : `${dashData.totals.cycles.toLocaleString("th-TH")} รอบซัก`}
                  textValue={dashData.totals.revenueSatang === null}
                />
                <KpiCard label="รอบซัก" value={dashData.totals.cycles.toLocaleString("th-TH")} detail={`ข้อมูล ${formatDate(dashData.from)} — ${formatDate(dashData.to)}`} />
                <KpiCard label="เครื่องที่มีข้อมูล" value={dashData.totals.machines.toLocaleString("th-TH")} detail={`${dashData.totals.running.toLocaleString("th-TH")} รายการสถานะกำลังใช้งาน`} />
                <KpiCard label="สาขา" value={dashData.branches.length.toLocaleString("th-TH")} detail={dashData.branches[0]?.branchName ?? "ไม่มีข้อมูลสาขา"} />
              </section>

              <section>
                <div className="section-heading">
                  <div>
                    <h2>ผลประกอบการรายสาขา</h2>
                    <p className="section-description">รายการสถานะ “กำลังใช้งาน” มาจาก usage และไม่ใช่การวัดสถานะทันที</p>
                  </div>
                  <span>{dashData.branches.length.toLocaleString("th-TH")} สาขาในขอบเขตข้อมูล</span>
                </div>
                {dashData.branches.length > 0 ? (
                  <div className="branch-grid">{dashData.branches.map((branch) => <BranchCard key={branch.branchId} branch={branch} />)}</div>
                ) : (
                  <div className="state-message">ไม่มีข้อมูลผลประกอบการในช่วงเวลานี้</div>
                )}
              </section>
            </>
          )}
        </Tabs.Panel>

        <Tabs.Panel id="twin" className="dashboard-panel">
          <section>
            <div className="section-heading">
              <div>
                <h2>ผังเครื่อง · Digital Twin</h2>
                <p className="section-description">สถานะและรอบคำนวณจากข้อมูล usage ไม่ใช่ live telemetry</p>
              </div>
              <span>รีเฟรช snapshot ทุก 60 วินาที</span>
            </div>
            {!validRange && <div className="error-message">เลือกช่วงวันที่ให้ถูกต้องก่อนโหลดข้อมูล</div>}
            {twinQuery.isLoading && <div className="loading-state compact" role="status" aria-live="polite"><span className="loading-orbit" />กำลังโหลดผังเครื่อง</div>}
            {twinQuery.isError && (
              <div className="error-message" role="alert">
                <span>ไม่สามารถโหลดผังเครื่องได้: {twinQuery.error.message}</span>
                <button type="button" className="secondary-button" onClick={() => void twinQuery.refetch()}>ลองใหม่</button>
              </div>
            )}
            {twinData && (
              <>
                <div className="data-context evidence-strip" aria-live="polite">
                  <span className="source-pill">{sourceLabel(twinData.source)}</span>
                  <span>{availabilityLabel(twinData.availability)}</span>
                  <strong>{formatDate(twinData.range.from)} — {formatDate(twinData.range.to)}</strong>
                  <span>ดึงเมื่อ {formatDateTime(twinData.fetchedAt)}</span>
                </div>
                <MachineFloor machines={twinData.machines} />
              </>
            )}
          </section>
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}

function KpiCard({ label, value, detail, textValue = false }: { label: string; value: string; detail: string; textValue?: boolean }) {
  return (
    <Card variant="transparent" className="surface-card kpi-card">
      <Card.Content>
        <span className="kpi-label">{label}</span>
        <strong className={`kpi-value${textValue ? " kpi-value--text" : ""}`}>{value}</strong>
        <span className="kpi-detail">{detail}</span>
      </Card.Content>
    </Card>
  );
}

function BranchCard({ branch }: { branch: DashboardData["branches"][0] }) {
  const utilization = branch.machines > 0 ? Math.min(branch.running / branch.machines, 1) : null;
  const percentage = utilization === null ? null : Math.round(utilization * 100);
  return (
    <Card variant="transparent" className="surface-card branch-card">
      <Card.Content>
        <div className="branch-card-head">
          <div>
            <span className="branch-code">{branch.branchId.slice(0, 8)}</span>
            <h3>{branch.branchName}</h3>
          </div>
          <span className="status-pill status-pill--neutral">{branch.running}/{branch.machines} รายการสถานะ</span>
        </div>
        <div className="branch-stats">
          <div><span>รายได้</span><strong>{branch.revenueSatang === null ? "ไม่พร้อมใช้งาน" : baht(branch.revenueSatang)}</strong></div>
          <div><span>รอบซัก</span><strong>{branch.cycles.toLocaleString("th-TH")}</strong></div>
          <div><span>เครื่องที่มีข้อมูล</span><strong>{branch.machines.toLocaleString("th-TH")}</strong></div>
          <div><span>รายการสถานะกำลังใช้งาน</span><strong>{branch.running.toLocaleString("th-TH")}</strong></div>
        </div>
        {percentage === null ? (
          <div className="utilization-unavailable">ไม่มีข้อมูลการใช้งานในช่วงเวลานี้</div>
        ) : (
          <div
            className="utilization-track"
            role="progressbar"
            aria-label={`${branch.branchName}: รายการสถานะกำลังใช้งาน ${branch.running} จาก ${branch.machines} เครื่องที่มีข้อมูล`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percentage}
            aria-valuetext={`${percentage}% ของเครื่องที่มีข้อมูล; ค่านี้มาจากรายการ usage ไม่ใช่สถานะทันที`}
          ><span style={{ width: `${percentage}%` }} /></div>
        )}
      </Card.Content>
    </Card>
  );
}

function MachineFloor({ machines }: { machines: Machine[] }) {
  const branches = Array.from(machines.reduce((map, machine) => {
    const key = `${machine.branchId ?? "unknown-branch"}:${machine.branchName}`;
    const current = map.get(key) ?? [];
    current.push(machine);
    map.set(key, current);
    return map;
  }, new Map<string, Machine[]>()));
  const knownCycleMachines = machines.filter((machine) => machine.cycleCount !== null).length;
  const knownCycles = machines.reduce((sum, machine) => sum + (machine.cycleCount ?? 0), 0);
  const running = machines.filter((machine) => machine.status === "running").length;

  if (machines.length === 0) return <div className="state-message">ไม่พบเครื่องใน Digital Twin สำหรับขอบเขตและช่วงเวลานี้</div>;

  return (
    <div className="machine-floor">
      <div className="machine-floor-summary">
        <div><span>เครื่องทั้งหมด</span><strong>{machines.length}</strong></div>
        <div><span>สถานะกำลังใช้งาน</span><strong>{running}</strong></div>
        <div><span>รอบที่มีหลักฐาน</span><strong>{knownCycleMachines > 0 ? knownCycles.toLocaleString("th-TH") : "ไม่พร้อมใช้งาน"}</strong></div>
        <div><span>สาขา</span><strong>{branches.length}</strong></div>
      </div>
      {branches.map(([branchKey, branchMachines]) => (
        <section className="machine-floor-branch" key={branchKey}>
          <div className="machine-floor-branch-head">
            <h3>{branchMachines[0]?.branchName ?? "สาขาที่ไม่ระบุ"}</h3>
            <span>{branchMachines.length.toLocaleString("th-TH")} เครื่อง</span>
          </div>
          <MachineGroup title="เครื่องซักผ้า" machines={branchMachines.filter((machine) => machine.machineKind === "washer")} />
          <MachineGroup title="เครื่องอบผ้า" machines={branchMachines.filter((machine) => machine.machineKind === "dryer")} />
        </section>
      ))}
    </div>
  );
}

function MachineGroup({ title, machines }: { title: string; machines: Machine[] }) {
  if (machines.length === 0) return null;
  return (
    <div className="machine-floor-group">
      <div className="machine-floor-group-label"><strong>{title}</strong><span>{machines.length.toLocaleString("th-TH")} เครื่อง</span></div>
      <div className="machine-floor-grid">
        {machines.map((machine) => <MachineCard key={`${machine.branchId ?? "unknown-branch"}-${machine.machineId ?? machine.machineCode}`} machine={machine} />)}
      </div>
    </div>
  );
}

function MachineCard({ machine }: { machine: Machine }) {
  const status = statusMeta(machine.status);
  return (
    <Card variant="transparent" className="surface-card machine-card machine-floor-card">
      <Card.Content>
        <div className="machine-card-head">
          <div>
            <span className="machine-code">{machine.machineCode}</span>
            <span className="machine-kind">{machineKindLabel(machine.machineKind)}</span>
          </div>
          <span className={`status-pill ${status.className}`}>{status.label}</span>
        </div>
        <div className="machine-floor-visual"><MachineDrum kind={machine.machineKind} status={machine.status} /></div>
        <p className="machine-card-branch">{machine.branchName}</p>
        <div className="machine-facts machine-floor-facts">
          <div><span>รอบในช่วง</span><strong>{machine.cycleCount === null ? "ไม่พร้อมใช้งาน" : machine.cycleCount.toLocaleString("th-TH")}</strong></div>
          <div><span>หลักฐานรอบ</span><strong>{machine.cycleCountSource === "machine_session_id" ? "machine session" : "ไม่มีหลักฐาน"}</strong></div>
        </div>
        <p className="kpi-detail">ใช้งานล่าสุด {machine.lastActiveAt ? formatDateTime(machine.lastActiveAt) : "ไม่มีข้อมูล"}</p>
      </Card.Content>
    </Card>
  );
}

function MachineDrum({ kind, status }: { kind: string; status: string | null }) {
  const running = status === "running" || status === "washing" || status === "drying";
  const offline = status === "offline";
  const warm = kind === "dryer";
  return (
    <svg className={`machine-drum machine-drum--${status ?? "unknown"}`} viewBox="0 0 120 100" aria-hidden="true">
      <rect className="machine-drum-body" x="18" y="8" width="84" height="84" rx="12" />
      <rect className="machine-drum-panel" x="30" y="17" width="60" height="7" rx="3.5" />
      <circle className="machine-drum-door" cx="60" cy="57" r="24" />
      <circle className="machine-drum-glass" cx="60" cy="57" r="17" />
      {running && <path className="machine-drum-wave" d="M47 60q7-7 13 0t13 0" />}
      {warm && <path className="machine-drum-heat" d="M55 72q-5-6 0-12t0-8" />}
      {offline && <path className="machine-drum-offline" d="M48 69 72 45" />}
      <circle className="machine-drum-led" cx="88" cy="20" r="2" />
    </svg>
  );
}
