import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Card, Tabs } from "@heroui/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { apiErrorMessage, apiUrl } from "../../lib/api/client";
import {
  availabilityLabel,
  branchStatCells,
  cycleAttributionView,
  dashboardKpis,
  emptyStateMessage,
  usagePresence,
  usageRowsLabel,
  isComparisonAvailable,
  priorPeriod,
  priorPeriodDelta,
  sortBranches,
  utilizationView,
  BRANCH_SORT_LABELS,
  type BranchSortId,
  type MetricCell
} from "../../lib/dashboard-view";
import {
  dashboardContext,
  dashboardSearch,
  presetRange,
  RANGE_PRESETS,
  type DashboardContext,
  type DashboardSearch
} from "../../lib/dashboard-search";
import { machineStatusMeta } from "../../lib/machine-status";
import {
  machineCycleFacts,
  machineFloorCycles,
  machineFloorGroups,
  machineFreshnessRow
} from "../../lib/machine-facts";
import {
  summaryAvailabilityLabel,
  summarySourceLabel,
  summaryView,
  type SummaryEnvelope
} from "../../lib/summary-view";
import { machineAvailability } from "../../lib/branch-availability-view";

/** The URL is the single source of truth for the working context, so a LINE
 *  user tapping back lands where they were and an owner can send a colleague
 *  "สาขา A, last Tuesday". Every field is optional: an absent one resolves to the
 *  7-day default in `dashboardContext`. An unrecognised `view` is dropped by the
 *  tab switch rather than reaching `Tabs`, and `from`/`to` are kept verbatim so
 *  a bad date is reported by the page instead of being quietly repaired. */
export const Route = createFileRoute("/_authenticated/dashboard")({
  validateSearch: (search: Record<string, unknown>): DashboardSearch => ({
    view: search.view === "twin" || search.view === "dashboard" ? search.view : undefined,
    branch: typeof search.branch === "string" && search.branch ? search.branch : undefined,
    from: typeof search.from === "string" && search.from ? search.from : undefined,
    to: typeof search.to === "string" && search.to ? search.to : undefined
  }),
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
  /** `usage_row` = usage rows exist (the count may legitimately be 0);
   *  `unavailable` = the source reported zero usage rows; `unknown` = the
   *  source has no usage-row concept (IRIS/demo). */
  cycleCountSource?: "usage_row" | "unavailable" | "unknown";
  /** Age of the newest usage evidence. Separate from `status`, which only
   *  says what that evidence claimed. Absent on an older API build. */
  freshness?: string;
  freshnessReason?: string | null;
  /** Whether the branch is trading right now. Absent on an older API build,
   *  which renders exactly what it renders today. Never absent-means-closed:
   *  see `machineAvailability`. */
  branchOpenState?: string;
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

function machineKindLabel(kind: string): string {
  if (kind === "washer") return "เครื่องซักผ้า";
  if (kind === "dryer") return "เครื่องอบผ้า";
  return kind || "ไม่ระบุประเภท";
}

function DashboardPage() {
  // The URL is the source of truth, not local state. A LINE user tapping back
  // returns to the window and branch they were reading, a desktop refresh keeps
  // it, and an owner can send a colleague the exact context.
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/dashboard" });
  const defaultRange = useMemo(recentRange, []);
  const context = dashboardContext(search, defaultRange);
  const view = context.view;
  const branchId = context.branchId;
  const range = { from: context.from, to: context.to };
  const validRange = context.validRange;
  // Sort is presentation-only and stays local: it is not part of what the URL is
  // shared to reproduce, and it never changes what is queried.
  const [branchSort, setBranchSort] = useState<BranchSortId>("name");

  const applyContext = (next: Partial<DashboardContext>) => {
    void navigate({
      search: (current) =>
        dashboardSearch({ ...dashboardContext(current, defaultRange), ...next }, defaultRange)
    });
  };

  const branchesQuery = useQuery({
    queryKey: ["report", "branches", "dashboard-filters"],
    queryFn: () => fetchJson<{ branches: Branch[] }>("/api/report/branches", "ไม่สามารถโหลดรายชื่อสาขาได้")
  });

  const dashQuery = useQuery({
    queryKey: ["report", "dashboard", branchId, range.from, range.to],
    queryFn: () => fetchJson<DashboardEnvelope>(reportPath("/api/report/dashboard", range.from, range.to, branchId), "ไม่สามารถโหลดแดชบอร์ดได้"),
    enabled: validRange,
    placeholderData: keepPreviousData
  });

  const twinQuery = useQuery({
    queryKey: ["twin", "dashboard", branchId, range.from, range.to],
    queryFn: () => fetchJson<TwinEnvelope>(reportPath("/api/twin", range.from, range.to, branchId), "ไม่สามารถโหลด Digital Twin ได้"),
    enabled: validRange && view === "twin",
    placeholderData: keepPreviousData,
    refetchInterval: 60000
  });

  const summaryQuery = useQuery({
    queryKey: ["report", "summary", branchId, range.from, range.to],
    queryFn: () =>
      fetchJson<SummaryEnvelope>(reportPath("/api/report/summary", range.from, range.to, branchId), "ไม่สามารถโหลดสรุปผู้บริหารได้"),
    enabled: validRange && view === "dashboard",
    placeholderData: keepPreviousData,
    // The summary counts the same cycles the KPI card does. When the window has
    // no usage rows there is nothing to summarise, and summaryView hides the
    // sentence rather than printing "0 cycles" as a finding.
    retry: false
  });

  // The immediately preceding window of equal length. Strictly subtraction of
  // two measured totals: AGENTS.md constrains seasonal and GBM claims and this
  // makes none. Gated on `isComparisonAvailable` so a range the API would reject
  // is never requested.
  const prior = useMemo(() => priorPeriod(range), [range.from, range.to]);
  const comparisonAvailable = validRange && isComparisonAvailable(prior, range);
  const priorQuery = useQuery({
    queryKey: ["report", "dashboard", "prior", branchId, prior?.from ?? "", prior?.to ?? ""],
    queryFn: () =>
      fetchJson<DashboardEnvelope>(
        reportPath("/api/report/dashboard", prior!.from, prior!.to, branchId),
        "ไม่สามารถโหลดข้อมูลช่วงก่อนหน้าได้"
      ),
    enabled: comparisonAvailable
  });
  const priorTotals = priorQuery.data?.dashboard.totals ?? null;
  // The prior window's own presence gates its cycles: a window with no usage rows
  // has no cycles to compare against, and reporting 0 would invent a drop to zero.
  const priorPresence = usagePresence(priorQuery.data?.dashboard.usageRowsInRange);
  const comparisonBasis = prior
    ? `เทียบกับ ${formatDate(prior.from)} — ${formatDate(prior.to)}`
    : "";

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
  // The two KPIs a change in money or volume actually means something for. The
  // redacted revenue produces "unavailable", which is the point: a withheld
  // number must not read as an unchanged one.
  const revenueDelta = priorPeriodDelta({
    current: dashData?.totals.revenueSatang ?? null,
    prior: priorTotals?.revenueSatang ?? null,
    label: "รายได้",
    formatNumber: formatCount
  });
  const cyclesDelta = priorPeriodDelta({
    current: dashData && presence === "present" ? dashData.totals.cycles : null,
    prior: priorTotals && priorPresence === "present" ? priorTotals.cycles : null,
    label: "รอบซัก",
    formatNumber: formatCount
  });
  const cycleDeltas = [revenueDelta, cyclesDelta].filter((d) => d.kind !== "unavailable");

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
          if (nextView === "dashboard" || nextView === "twin") applyContext({ view: nextView });
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
              onChange={(event) => applyContext({ branchId: event.target.value })}
            >
              <option value="">ทุกสาขาที่มีสิทธิ์</option>
              {(branchesQuery.data?.branches ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor="dashboard-from">ตั้งแต่วันที่</label>
            <input id="dashboard-from" type="date" value={range.from} max={range.to} onChange={(event) => applyContext({ from: event.target.value })} />
          </div>
          <div className="filter-field">
            <label htmlFor="dashboard-to">ถึงวันที่</label>
            <input id="dashboard-to" type="date" value={range.to} min={range.from} onChange={(event) => applyContext({ to: event.target.value })} />
          </div>
          <div className="range-presets" role="group" aria-label="เลือกช่วงเวลาที่ใช้บ่อย">
            {RANGE_PRESETS.map((preset) => {
              const presetDates = presetRange(preset.days);
              const active = range.from === presetDates.from && range.to === presetDates.to;
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`secondary-button${active ? " secondary-button--active" : ""}`}
                  aria-pressed={active}
                  onClick={() => applyContext({ ...presetDates })}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <p className="filter-note" role="status">วันที่ใช้รูปแบบ YYYY-MM-DD และส่งขอบเขตสาขาไปยังเซิร์ฟเวอร์ · ช่วงที่เลือกถูกเก็บไว้ใน URL เพื่อกลับมาดูซ้ำหรือแชร์ได้</p>
        </section>

        <Tabs.Panel id="dashboard" className="dashboard-panel">
          {!validRange && <div className="error-message">เลือกช่วงวันที่ให้ถูกต้องก่อนโหลดข้อมูล</div>}
          {/* The one error path on this page that offered no way forward: a
              failed branch list left the filter permanently empty with nothing to
              retry, while every sibling query had a button. */}
          {branchesQuery.isError && (
            <div className="error-message flex flex-wrap items-center gap-3" role="alert">
              <span>ไม่สามารถโหลดรายชื่อสาขาได้: {branchesQuery.error.message}</span>
              <button type="button" className="secondary-button" onClick={() => void branchesQuery.refetch()}>ลองใหม่</button>
            </div>
          )}
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

              {/* Prior-period change. Stated as subtraction of two measured
                  totals against the named window, never as a forecast. An
                  unavailable comparison says so rather than omitting the row,
                  so its absence is not read as "no change". */}
              <div className="comparison-strip" aria-live="polite">
                <span className="comparison-basis">{comparisonBasis || "ช่วงก่อนหน้าคำนวณไม่ได้"}</span>
                {!comparisonAvailable && <span className="comparison-note">เทียบช่วงก่อนหน้าไม่ได้ · ช่วงวันที่ยาวเกินขอบเขตที่ระบบรองรับ</span>}
                {comparisonAvailable && priorQuery.isError && (
                  <span className="comparison-note">โหลดยอดช่วงก่อนหน้าไม่สำเร็จ: {priorQuery.error.message}</span>
                )}
                {comparisonAvailable && priorQuery.isLoading && <span className="comparison-note">กำลังโหลดยอดช่วงก่อนหน้า</span>}
                {comparisonAvailable && !priorQuery.isLoading && !priorQuery.isError && cycleDeltas.length === 0 && (
                  <span className="comparison-note">ไม่มียอดในช่วงก่อนหน้าให้เทียบ</span>
                )}
                {cycleDeltas.map((delta) => (
                  <span
                    key={delta.label}
                    className={`comparison-delta comparison-delta--${delta.kind === "changed" ? delta.direction : "flat"}`}
                  >
                    {delta.label}
                  </span>
                ))}
              </div>

              <section>
                <div className="section-heading">
                  <div>
                    <h2>ผลประกอบการรายสาขา</h2>
                    <p className="section-description">รายการสถานะ “กำลังใช้งาน” มาจาก usage และไม่ใช่การวัดสถานะทันที</p>
                  </div>
                  <div className="section-heading-actions">
                    <span>{dashData.branches.length.toLocaleString("th-TH")} สาขาในขอบเขตข้อมูล</span>
                    <div className="filter-field filter-field--sort">
                      <label htmlFor="branch-sort">เรียงตาม</label>
                      <select
                        id="branch-sort"
                        value={branchSort}
                        onChange={(event) => setBranchSort(event.target.value as BranchSortId)}
                      >
                        {Object.entries(BRANCH_SORT_LABELS).map(([id, label]) => (
                          <option key={id} value={id}>{label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
                {dashData.branches.length > 0 ? (
                  <div className="branch-grid">{sortBranches(dashData.branches, branchSort).map((branch) => <BranchCard key={branch.branchId} branch={branch} presence={presence} />)}</div>
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
          {/* The color follows the measured evidence; the text carries the number,
              so the meaning survives without color. */}
          <span className={`status-pill ${cells.statusClassName}`}>{cells.statusPill}</span>
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
  // Coverage, not just a sum: one machine of forty having a count must not
  // present that machine's cycles as the floor's.
  const floorCycles = machineFloorCycles(machines);
  const running = machines.filter((machine) => machine.status === "running").length;

  if (machines.length === 0) return <div className="state-message">ไม่พบเครื่องใน Digital Twin สำหรับขอบเขตและช่วงเวลานี้</div>;

  return (
    <div className="machine-floor">
      <div className="machine-floor-summary">
        <div><span>เครื่องทั้งหมด</span><strong>{machines.length}</strong></div>
        <div><span>สถานะกำลังใช้งาน</span><strong>{running}</strong></div>
        <div>
          <span>รอบที่นับได้</span>
          <strong>{floorCycles.value}</strong>
          <span className="machine-floor-coverage">{floorCycles.coverage}</span>
        </div>
        <div><span>สาขา</span><strong>{branches.length}</strong></div>
      </div>
      {branches.map(([branchKey, branchMachines]) => (
        <section className="machine-floor-branch" key={branchKey}>
          <div className="machine-floor-branch-head">
            <h3>{branchMachines[0]?.branchName ?? "สาขาที่ไม่ระบุ"}</h3>
            <span>{branchMachines.length.toLocaleString("th-TH")} เครื่อง</span>
          </div>
          {/* Every machine lands in a rendered group, so "เครื่องทั้งหมด" and the
              cards below it always agree. A machine of an unrecognised kind used
              to count toward the total and produce no card at all. */}
          {machineFloorGroups(branchMachines).map((group) => (
            <MachineGroup key={group.title} title={group.title} machines={group.machines} />
          ))}
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
  const cycles = machineCycleFacts(machine);
  const freshness = machineFreshnessRow(machineAvailability(machine.freshness, machine.branchOpenState));
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
        {/* Freshness is a separate axis from status: `running` describes what
            the last usage row said, which may be days old. Without this pill a
            six-day-old status renders exactly like a live one. */}
        {freshness && (
          <div className="machine-card-status-row">
            <span className={`status-pill ${freshness.className}`}>{freshness.label}</span>
          </div>
        )}
        <p className="machine-card-branch">{machine.branchName}</p>
        <div className="machine-facts machine-floor-facts">
          <div><span>รอบในช่วง</span><strong>{cycles.value}</strong></div>
          <div><span>ที่มาของจำนวนรอบ</span><strong>{cycles.source}</strong></div>
        </div>
        <p className="kpi-detail">ใช้งานล่าสุด {machine.lastActiveAt ? formatDateTime(machine.lastActiveAt) : "ไม่มีข้อมูล"}</p>
      </Card.Content>
    </Card>
  );
}
