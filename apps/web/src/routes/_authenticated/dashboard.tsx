import { createFileRoute } from "@tanstack/react-router";
import { Card, Tabs } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiErrorMessage, apiUrl } from "../../lib/api/client";
import {
  branchStatCells,
  cycleAttributionView,
  dashboardKpis,
  emptyStateMessage,
  usagePresence,
  usageRowsLabel,
  utilizationView,
  type MetricCell
} from "../../lib/dashboard-view";
import { machineStatusMeta } from "../../lib/machine-status";
import {
  summaryAvailabilityLabel,
  summarySourceLabel,
  summaryView,
  type SummaryEnvelope
} from "../../lib/summary-view";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage
});

type Source = "clickhouse" | "demo";
type Availability = "usage-derived" | "available" | string;

type DashboardData = {
  from: string;
  to: string;
  source: Source;
  usageRowsInRange: number | null;
  /** How much of `totals.cycles` carries a `machine_session_id`. `null` on the
   *  demo/IRIS path, which cannot measure it. */
  cycleAttribution: { countedRows: number; attributedRows: number; unattributedRows: number } | null;
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
  cycleCountSource?: "usage_row" | "unavailable";
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

function formatCount(value: number): string {
  return value.toLocaleString("th-TH");
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

  const summaryQuery = useQuery({
    queryKey: ["report", "summary", branchId, range.from, range.to],
    queryFn: () =>
      fetchJson<SummaryEnvelope>(reportPath("/api/report/summary", range.from, range.to, branchId), "ไม่สามารถโหลดสรุปผู้บริหารได้"),
    enabled: validRange && view === "dashboard",
    // The summary counts the same cycles the KPI card does. When the window has
    // no usage rows there is nothing to summarise, and summaryView hides the
    // sentence rather than printing "0 cycles" as a finding.
    retry: false
  });

  const dashData = dashQuery.data?.dashboard;
  const twinData = twinQuery.data;
  const activeSource = view === "twin" ? twinData?.source ?? null : dashQuery.data?.source ?? null;
  const activeAvailability = view === "twin" ? twinData?.availability ?? null : dashQuery.data?.availability ?? null;
  const activeRange = view === "twin" ? twinData?.range ?? null : dashQuery.data?.range ?? null;
  const activeFetchedAt = view === "twin" ? twinData?.fetchedAt ?? null : dashQuery.data?.fetchedAt ?? null;
  // Presence comes from the API's usage-row count, never from cycles, revenue or
  // the machine count: a window with sessions but no paid/finished rows is
  // legitimately 0 cycles, and the machine count is inventory, not usage.
  const presence = usagePresence(dashData?.usageRowsInRange);
  const emptyWindowMessage = dashData ? emptyStateMessage(presence) : null;
  // A right number that is silently incomplete is still misleading: the cycle
  // KPI counts usage rows, and most real rows carry no machine_session_id. The
  // gap is measured server-side and stated here, next to the number.
  const attribution = cycleAttributionView(dashData?.cycleAttribution, formatCount);
  const kpis = dashboardKpis({
    totals: dashData?.totals ?? { revenueSatang: null, cycles: 0, machines: 0, running: 0 },
    branchCount: dashData?.branches.length ?? 0,
    firstBranchName: dashData?.branches[0]?.branchName ?? null,
    range: dashData ? `${formatDate(dashData.from)} — ${formatDate(dashData.to)}` : "",
    presence,
    formatNumber: formatCount,
    formatBaht: baht
  });
  // The summary sentence counts the same cycles as the KPI card, so the
  // attribution gap printed below the KPIs covers it too. It is rendered above
  // them only because it is the sentence an executive reads first.
  const summary = summaryView({
    summary: summaryQuery.data?.summary,
    usageRowsInRange: dashData?.usageRowsInRange
  });

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
            <div className="error-message flex flex-wrap items-center gap-3" role="alert">
              <span>ไม่สามารถโหลดข้อมูลแดชบอร์ดได้: {dashQuery.error.message}</span>
              <button type="button" className="secondary-button" onClick={() => void dashQuery.refetch()}>ลองใหม่</button>
            </div>
          )}
          {dashData && (
            <>
              <div className="data-context evidence-strip" aria-live="polite">
                <span className="source-pill">{sourceLabel(dashQuery.data?.source ?? null)}</span>
                <span>{availabilityLabel(dashQuery.data?.availability ?? null)}</span>
                <strong>{formatDate(dashData.from)} — {formatDate(dashData.to)}</strong>
                <span>{usageRowsLabel(dashData.usageRowsInRange)}</span>
                <span>ดึงเมื่อ {formatDateTime(dashQuery.data?.fetchedAt ?? null)}</span>
              </div>
              {emptyWindowMessage && <div className="state-message">{emptyWindowMessage}</div>}

              {/* Ahead of the KPI cards, because it is the sentence an
                  executive reads first — and the attribution note ahead of
                  both, because it qualifies every cycle count on this page. */}
              {attribution.kind !== "none" && (
                <div className="state-message" role="status">{attribution.message}</div>
              )}

              {summaryQuery.isError && (
                <div className="state-message" role="status">สรุปผู้บริหารไม่พร้อมใช้งาน: {summaryQuery.error.message}</div>
              )}
              {summary.kind === "text" && (
                <section className="surface-card" aria-label="สรุปสำหรับผู้บริหาร">
                  <div className="section-heading">
                    <div>
                      <h2>สรุปสำหรับผู้บริหาร</h2>
                      <p className="section-description">เรียงจากตัวเลขชุดเดียวกับการ์ดด้านล่างด้วยกฎคงที่ ไม่ใช่ข้อความที่โมเดลเขียน</p>
                    </div>
                  </div>
                  <p className="executive-summary">{summary.text}</p>
                  <div className="data-context" aria-live="polite">
                    <span className="source-pill">{summarySourceLabel(summaryQuery.data?.source)}</span>
                    <span>{summaryAvailabilityLabel(summaryQuery.data?.availability)}</span>
                    {summaryQuery.data?.range && (
                      <strong>{formatDate(summaryQuery.data.range.from)} — {formatDate(summaryQuery.data.range.to)}</strong>
                    )}
                    <span>สร้างเมื่อ {formatDateTime(summaryQuery.data?.generatedAt ?? null)}</span>
                  </div>
                </section>
              )}

              <section className="kpi-grid" aria-label="ตัวชี้วัดหลัก">
                <KpiCard cell={kpis.revenue} />
                <KpiCard cell={kpis.cycles} />
                <KpiCard cell={kpis.inventory} />
                <KpiCard cell={kpis.branches} />
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
                  <div className="branch-grid">{dashData.branches.map((branch) => <BranchCard key={branch.branchId} branch={branch} presence={presence} />)}</div>
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
                <p className="section-description">สถานะและรอบคำนวณจากแถว usage ไม่ใช่ live telemetry</p>
              </div>
              <span>รีเฟรช snapshot ทุก 60 วินาที</span>
            </div>
            {!validRange && <div className="error-message">เลือกช่วงวันที่ให้ถูกต้องก่อนโหลดข้อมูล</div>}
            {twinQuery.isLoading && <div className="loading-state compact" role="status" aria-live="polite"><span className="loading-orbit" />กำลังโหลดผังเครื่อง</div>}
            {twinQuery.isError && (
              <div className="error-message flex flex-wrap items-center gap-3" role="alert">
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

function KpiCard({ cell }: { cell: MetricCell }) {
  return (
    <Card variant="transparent" className="surface-card kpi-card">
      <Card.Content>
        <span className="kpi-label">{cell.label}</span>
        <strong className={`kpi-value${cell.textValue ? " kpi-value--text" : ""}`}>{cell.value}</strong>
        <span className="kpi-detail">{cell.detail}</span>
      </Card.Content>
    </Card>
  );
}

function BranchCard({ branch, presence }: { branch: DashboardData["branches"][0]; presence: ReturnType<typeof usagePresence> }) {
  const cells = branchStatCells(branch, presence, formatCount, baht);
  const utilization = utilizationView(branch, presence);
  return (
    <Card variant="transparent" className="surface-card branch-card">
      <Card.Content>
        <div className="branch-card-head">
          <div>
            <span className="branch-code">{branch.branchId.slice(0, 8)}</span>
            <h3>{branch.branchName}</h3>
          </div>
          <span className="status-pill status-pill--neutral">{cells.statusPill}</span>
        </div>
        <div className="branch-stats">
          <div><span>{cells.revenue.label}</span><strong>{cells.revenue.value}</strong></div>
          <div><span>{cells.cycles.label}</span><strong>{cells.cycles.value}</strong></div>
          <div><span>{cells.machines.label}</span><strong>{cells.machines.value}</strong></div>
          <div><span>{cells.running.label}</span><strong>{cells.running.value}</strong></div>
        </div>
        {utilization.kind === "unavailable" ? (
          <div className="utilization-unavailable">{utilization.message}</div>
        ) : (
          <div
            className="utilization-track"
            role="progressbar"
            aria-label={utilization.ariaLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={utilization.percentage}
            aria-valuetext={utilization.ariaValueText}
          ><span style={{ width: `${utilization.percentage}%` }} /></div>
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
        <div><span>รอบที่นับได้</span><strong>{knownCycleMachines > 0 ? knownCycles.toLocaleString("th-TH") : "ไม่พร้อมใช้งาน"}</strong></div>
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
  const status = machineStatusMeta(machine.status);
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
          <div><span>ที่มาของจำนวนรอบ</span><strong>{machine.cycleCountSource === "usage_row" ? "นับจากแถว usage" : "ไม่มีแถว usage"}</strong></div>
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
