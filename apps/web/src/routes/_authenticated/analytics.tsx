import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useState } from "react";
import { alertUnavailableReason } from "../../lib/alerts-view";
import { apiErrorMessage, apiUrl } from "../../lib/api/client";
import { authAtom } from "../../lib/atoms/auth";
import { canViewRevenue as revenueAllowed } from "../../lib/access";
import { temperatureSummary, type TemperatureTruncation } from "../../lib/temperature-view";
import { hourRangeLabel, offPeakEmptyReason, weekdayLabel, type OffPeakRow, type OffPeakRules } from "../../lib/offpeak-view";

export const Route = createFileRoute("/_authenticated/analytics")({
  component: AnalyticsPage
});

type SourceTag = "synthetic" | "real" | "mixed" | "empty" | "unverifiable";
type AnalyticsMeta = {
  range: { from: string; to: string };
  branchId: string | null;
  dataSource: SourceTag;
  method?: string;
  rules?: Record<string, unknown>;
  caveats?: string[];
  truncation?: TemperatureTruncation;
};
type AnalyticsEnvelope<T> = { meta: AnalyticsMeta; data: T[] };
type RevenueRow = { date: string; branchId: string; branchName: string; revenueSatang: number; cycles: number };
type CycleRow = { date: string; branchId: string; branchName: string; cycles: number; avgDurationMin: number };
type UtilizationRow = { hourBucket: string; machineId: string; machineCode: string; totalDurationMin: number; cycles: number };
type TemperatureRow = { occurredAt: string; machineId: string; machineCode: string; temperatureF: number | null; temperatureC: number | null; phase: string };
type WeatherRow = { date: string; branchName: string; cycles: number; avgTempC: number | null; avgHumidityPct: number | null; totalRainMm: number | null; missingTemp: number };
type Branch = { id: string; name: string };
type Alert = {
  id: string;
  branchId: string | null;
  machineId: string | null;
  ruleId: string | null;
  ruleVersion: string | null;
  severity: string;
  title: string;
  detail: string | null;
  tags: string[];
  evidence: Record<string, unknown>;
  detectedAt: string;
  acknowledgedAt: string | null;
  acknowledgedLocally?: boolean;
};
type AlertEnvelope = {
  contractVersion: string;
  source: string;
  fetchedAt: string;
  alerts: Alert[];
  availability: "available" | "unavailable" | string;
  reason?: string;
};

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

function analyticsPath(path: string, from: string, to: string, branchId: string): string {
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
  return new Intl.NumberFormat("th-TH", { style: "currency", currency: "THB", maximumFractionDigits: 0 }).format(satang / 100);
}

function formatDate(value: string): string {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" });
}

function formatDateTime(value: string | number | null): string {
  if (value === null) return "ไม่มีข้อมูล";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function sourceLabel(source: SourceTag | string | null): string {
  if (source === "real") return "ข้อมูลจริง";
  if (source === "synthetic") return "ข้อมูลสังเคราะห์";
  if (source === "mixed") return "ข้อมูลจริงและสังเคราะห์ผสมกัน";
  if (source === "empty") return "ไม่มีแถวข้อมูล";
  // The weather table has no provenance marker, so real-vs-generated cannot be
  // determined. Labelling it "ข้อมูลจริง" would assert something unprovable.
  if (source === "unverifiable") return "ตรวจสอบแหล่งที่มาไม่ได้";
  if (source === "demo") return "โหมด Demo";
  if (source === "clickhouse") return "แหล่งข้อมูล: ClickHouse";
  return source ? `แหล่งข้อมูล: ${source}` : "ยังไม่มีข้อมูลแหล่งที่มา";
}

function severityMeta(severity: string): { label: string; className: string } {
  const value = severity.toLowerCase();
  if (value.includes("critical") || value.includes("high")) return { label: "วิกฤต", className: "status-pill--danger" };
  if (value.includes("warn") || value.includes("medium")) return { label: "เฝ้าระวัง", className: "status-pill--warning" };
  return { label: "ข้อมูล", className: "status-pill--neutral" };
}

function AnalyticsPage() {
  const [user] = useAtom(authAtom);
  const queryClient = useQueryClient();
  const [branchId, setBranchId] = useState("");
  const [range, setRange] = useState(recentRange);
  const validRange = Boolean(range.from && range.to && range.from <= range.to);
  const canViewRevenue = revenueAllowed(user);

  const branchesQuery = useQuery({
    queryKey: ["report", "branches", "analytics-filters"],
    queryFn: () => fetchJson<{ branches: Branch[] }>("/api/report/branches", "ไม่สามารถโหลดรายชื่อสาขาได้")
  });

  const revenueQuery = useQuery({
    queryKey: ["analytics", "revenue", branchId, range.from, range.to],
    queryFn: () => fetchJson<AnalyticsEnvelope<RevenueRow>>(analyticsPath("/api/v1/analytics/revenue/daily", range.from, range.to, branchId), "ไม่สามารถโหลดรายได้รายวันได้"),
    enabled: validRange && canViewRevenue
  });

  const cyclesQuery = useQuery({
    queryKey: ["analytics", "cycles", branchId, range.from, range.to],
    queryFn: () => fetchJson<AnalyticsEnvelope<CycleRow>>(analyticsPath("/api/v1/analytics/cycles/daily", range.from, range.to, branchId), "ไม่สามารถโหลดรอบซักรายวันได้"),
    enabled: validRange
  });

  const utilizationQuery = useQuery({
    queryKey: ["analytics", "utilization", branchId, range.from, range.to],
    queryFn: () => fetchJson<AnalyticsEnvelope<UtilizationRow>>(analyticsPath("/api/v1/analytics/utilization/heatmap", range.from, range.to, branchId), "ไม่สามารถโหลดข้อมูลการใช้งานได้"),
    enabled: validRange
  });

  const temperatureQuery = useQuery({
    queryKey: ["analytics", "temperature", branchId, range.from, range.to],
    queryFn: () => fetchJson<AnalyticsEnvelope<TemperatureRow>>(analyticsPath("/api/v1/analytics/temperature/curve", range.from, range.to, branchId), "ไม่สามารถโหลดข้อมูลอุณหภูมิได้"),
    enabled: validRange
  });

  const offPeakQuery = useQuery({
    queryKey: ["analytics", "off-peak", branchId, range.from, range.to],
    queryFn: () => fetchJson<AnalyticsEnvelope<OffPeakRow>>(analyticsPath("/api/v1/analytics/off-peak", range.from, range.to, branchId), "ไม่สามารถโหลดช่วงเวลาที่ไม่หนาแน่นได้"),
    enabled: validRange
  });

  const weatherQuery = useQuery({
    queryKey: ["analytics", "weather", branchId, range.from, range.to],
    queryFn: () => fetchJson<AnalyticsEnvelope<WeatherRow>>(analyticsPath("/api/v1/analytics/weather/usage", range.from, range.to, branchId), "ไม่สามารถโหลดข้อมูลอากาศได้"),
    enabled: validRange
  });

  const alertsQuery = useQuery({
    queryKey: ["report", "alerts", branchId, range.from, range.to],
    queryFn: async () => {
      const data = await fetchJson<{ alerts: AlertEnvelope }>(analyticsPath("/api/report/alerts", range.from, range.to, branchId), "ไม่สามารถโหลดการแจ้งเตือนได้");
      return data.alerts;
    },
    enabled: validRange
  });

  const acknowledgeMutation = useMutation({
    mutationFn: async ({ id, branchId: alertBranchId }: { id: string; branchId: string }) => {
      const response = await fetch(apiUrl(`/api/alerts/${encodeURIComponent(id)}/acknowledge`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ branchId: alertBranchId })
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, `รับทราบการแจ้งเตือนไม่สำเร็จ (HTTP ${response.status})`));
      return (await response.json()) as { ok: boolean };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["report", "alerts"] });
    }
  });

  const revenueMax = Math.max(0, ...(revenueQuery.data?.data ?? []).map((row) => row.revenueSatang));
  const utilizationMax = Math.max(0, ...(utilizationQuery.data?.data ?? []).map((row) => row.totalDurationMin));
  const temperatureRows = temperatureQuery.data?.data ?? [];
  // The API caps the curve at the newest 5,000 samples. avg/min/max therefore
  // describe the returned rows, not necessarily the whole selected range, and
  // the summary carries that distinction so the panel cannot imply completeness.
  const temperature = temperatureSummary(temperatureRows, temperatureQuery.data?.meta.truncation);
  const utilizationRows = utilizationQuery.data?.data ?? [];
  const totalDuration = utilizationRows.reduce((sum, row) => sum + row.totalDurationMin, 0);
  const totalCycles = utilizationRows.reduce((sum, row) => sum + row.cycles, 0);

  return (
    <div className="grid gap-4 md:gap-6">
      <section className="analytics-section rounded-xl border border-border bg-surface p-4 shadow-surface md:p-6">
        <div className="page-header flex flex-col items-start gap-3 md:flex-row md:items-end md:justify-between md:gap-5">
          <div>
            <h1>พื้นที่วิเคราะห์ข้อมูล</h1>
            <p className="hidden sm:block">ตรวจสอบรายได้ รอบซัก การใช้งาน อุณหภูมิ ช่วงเวลาที่ไม่หนาแน่น อากาศเทียบรอบซัก และหลักฐานการแจ้งเตือนในขอบเขตที่เซิร์ฟเวอร์อนุญาต</p>
          </div>
        </div>
      </section>

      <section className="analytics-section grid grid-cols-2 gap-2 rounded-xl border border-border bg-surface p-3 shadow-surface md:grid-cols-4 md:gap-3 md:p-4" aria-label="ตัวกรองข้อมูลวิเคราะห์">
        <div className="col-span-2 grid min-w-0 gap-1 text-xs font-medium text-muted md:col-span-1 md:gap-1.5">
          <label htmlFor="analytics-branch">สาขา</label>
          <select id="analytics-branch" value={branchId} disabled={branchesQuery.isLoading} onChange={(event) => setBranchId(event.target.value)}>
            <option value="">ทุกสาขาที่มีสิทธิ์</option>
            {(branchesQuery.data?.branches ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        </div>
        <div className="grid min-w-0 gap-1 text-xs font-medium text-muted md:gap-1.5">
          <label htmlFor="analytics-from" className="sr-only md:not-sr-only">ตั้งแต่วันที่</label>
          <input id="analytics-from" type="date" value={range.from} max={range.to} onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))} />
        </div>
        <div className="grid min-w-0 gap-1 text-xs font-medium text-muted md:gap-1.5">
          <label htmlFor="analytics-to" className="sr-only md:not-sr-only">ถึงวันที่</label>
          <input id="analytics-to" type="date" value={range.to} min={range.from} onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))} />
        </div>
        <p className="col-span-2 hidden text-[11px] leading-relaxed text-muted md:col-span-full md:block" role="status">เซิร์ฟเวอร์ตรวจสอบบทบาท สาขา และช่วงวันที่ซ้ำอีกครั้ง</p>
      </section>

      {!validRange && <div className="error-message rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground">เลือกช่วงวันที่ให้ถูกต้องก่อนโหลดข้อมูล</div>}
      {branchesQuery.isError && <div className="error-message rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">ไม่สามารถโหลดรายชื่อสาขาได้: {branchesQuery.error.message}</div>}

      <Card variant="transparent" className="analytics-section rounded-xl border border-border bg-surface p-4 shadow-surface md:p-6 min-w-0">
        <Card.Content>
          <div className="flex flex-col items-start gap-1 md:flex-row md:items-baseline md:justify-between md:gap-3"><h2>รายได้รายวัน</h2><span>ต้องใช้บทบาท Owner หรือ Manager</span></div>
          {!canViewRevenue ? (
            <div className="state-message rounded-xl border border-dashed border-border bg-surface-secondary p-4 text-sm leading-relaxed text-muted">ไม่มีสิทธิ์ดูรายได้ และไม่ได้ส่งคำขอ revenue ไปยังเซิร์ฟเวอร์</div>
          ) : revenueQuery.isLoading ? (
            <div className="flex min-h-[60vh] items-center justify-center gap-2.5 text-sm text-muted min-h-[150px]" role="status"><span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />กำลังโหลดรายได้รายวัน</div>
          ) : revenueQuery.isError ? (
            <div className="error-message rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">ไม่สามารถโหลดรายได้รายวันได้: {revenueQuery.error.message}</div>
          ) : revenueQuery.data && (
            <AnalyticsResult query={revenueQuery} empty="ไม่มีข้อมูลรายได้ในช่วงเวลานี้">
              <DataTable headers={["วันที่", "สาขา", "รายได้", "รอบซัก"]}>
                {revenueQuery.data.data.map((row) => {
                  const percentage = revenueMax > 0 ? Math.round((row.revenueSatang / revenueMax) * 100) : 0;
                  return (
                    <tr key={`${row.branchId}-${row.date}`}>
                      <td>{formatDate(row.date)}</td>
                      <td>{row.branchName}</td>
                      <td>
                        <div className="flex flex-col items-start gap-0.5 md:flex-row md:items-baseline md:justify-between md:gap-3"><strong>{baht(row.revenueSatang)}</strong><span>{percentage}% ของสูงสุดในชุดข้อมูล</span></div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-tertiary" role="progressbar" aria-label={`${row.branchName} ${formatDate(row.date)} รายได้ ${baht(row.revenueSatang)}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}><span style={{ width: `${percentage}%` }} /></div>
                      </td>
                      <td className="font-mono tabular-nums whitespace-nowrap">{row.cycles.toLocaleString("th-TH")}</td>
                    </tr>
                  );
                })}
              </DataTable>
            </AnalyticsResult>
          )}
        </Card.Content>
      </Card>

      <Card variant="transparent" className="analytics-section rounded-xl border border-border bg-surface p-4 shadow-surface md:p-6 min-w-0">
        <Card.Content>
          <div className="flex flex-col items-start gap-1 md:flex-row md:items-baseline md:justify-between md:gap-3"><h2>รอบซักและระยะเวลาเฉลี่ย</h2></div>
          {cyclesQuery.isLoading ? (
            <div className="flex min-h-[60vh] items-center justify-center gap-2.5 text-sm text-muted min-h-[150px]" role="status"><span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />กำลังโหลดรอบซักรายวัน</div>
          ) : cyclesQuery.isError ? (
            <div className="error-message rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">ไม่สามารถโหลดรอบซักรายวันได้: {cyclesQuery.error.message}</div>
          ) : cyclesQuery.data && (
            <AnalyticsResult query={cyclesQuery} empty="ไม่มีข้อมูลรอบซักในช่วงเวลานี้">
              <DataTable headers={["วันที่", "สาขา", "รอบซัก", "ระยะเวลาเฉลี่ย"]}>
                {cyclesQuery.data.data.map((row) => (
                  <tr key={`${row.branchId}-${row.date}`}>
                    <td>{formatDate(row.date)}</td><td>{row.branchName}</td><td className="font-mono tabular-nums whitespace-nowrap">{row.cycles.toLocaleString("th-TH")}</td><td className="font-mono tabular-nums whitespace-nowrap">{Number.isFinite(row.avgDurationMin) ? `${row.avgDurationMin.toFixed(1)} นาที` : "ไม่ทราบ"}</td>
                  </tr>
                ))}
              </DataTable>
            </AnalyticsResult>
          )}
        </Card.Content>
      </Card>

      <Card variant="transparent" className="analytics-section rounded-xl border border-border bg-surface p-4 shadow-surface md:p-6 min-w-0">
        <Card.Content>
          <div className="flex flex-col items-start gap-1 md:flex-row md:items-baseline md:justify-between md:gap-3"><h2>สรุปการใช้งาน</h2><span>จากชั่วโมงและเครื่องที่มีข้อมูล</span></div>
          {utilizationQuery.isLoading ? (
            <div className="flex min-h-[60vh] items-center justify-center gap-2.5 text-sm text-muted min-h-[150px]" role="status"><span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />กำลังโหลดข้อมูลการใช้งาน</div>
          ) : utilizationQuery.isError ? (
            <div className="error-message rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">ไม่สามารถโหลดข้อมูลการใช้งานได้: {utilizationQuery.error.message}</div>
          ) : utilizationQuery.data && (
            <AnalyticsResult query={utilizationQuery} empty="ไม่มีข้อมูลการใช้งานในช่วงเวลานี้">
              <fieldset className="stat-grid stat-grid--cards mb-3 grid grid-cols-2 gap-2 md:mb-4 md:grid-cols-4">
                <legend className="sr-only">สรุปการใช้งาน</legend>
                <div><span>เวลาใช้งานรวม</span><strong>{totalDuration.toLocaleString("th-TH", { maximumFractionDigits: 1 })} นาที</strong></div>
                <div><span>รอบที่นับได้</span><strong>{totalCycles.toLocaleString("th-TH")}</strong></div>
                <div><span>ชั่วโมงที่มีข้อมูล</span><strong>{new Set(utilizationRows.map((row) => row.hourBucket)).size.toLocaleString("th-TH")}</strong></div>
              </fieldset>
              <DataTable headers={["ช่วงเวลา", "เครื่อง", "เวลาใช้งาน", "รอบ"]}>
                {utilizationRows.slice(0, 12).map((row) => {
                  const percentage = utilizationMax > 0 ? Math.round((row.totalDurationMin / utilizationMax) * 100) : 0;
                  return (
                    <tr key={`${row.machineId}-${row.hourBucket}`}>
                      <td>{formatDateTime(row.hourBucket)}</td><td className="font-mono text-[11px] text-muted">{row.machineCode}</td>
                      <td><div className="flex flex-col items-start gap-0.5 md:flex-row md:items-baseline md:justify-between md:gap-3"><strong>{row.totalDurationMin.toLocaleString("th-TH", { maximumFractionDigits: 1 })} นาที</strong></div><div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-tertiary" role="progressbar" aria-label={`${row.machineCode} ใช้งาน ${row.totalDurationMin} นาที`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}><span style={{ width: `${percentage}%` }} /></div></td>
                      <td className="font-mono tabular-nums whitespace-nowrap">{row.cycles.toLocaleString("th-TH")}</td>
                    </tr>
                  );
                })}
              </DataTable>
            </AnalyticsResult>
          )}
        </Card.Content>
      </Card>

      <Card variant="transparent" className="analytics-section rounded-xl border border-border bg-surface p-4 shadow-surface md:p-6 min-w-0">
        <Card.Content>
          <div className="flex flex-col items-start gap-1 md:flex-row md:items-baseline md:justify-between md:gap-3"><h2>สรุปอุณหภูมิ</h2><span>เฉพาะ sample ที่มีค่าอุณหภูมิ</span></div>
          {temperatureQuery.isLoading ? (
            <div className="flex min-h-[60vh] items-center justify-center gap-2.5 text-sm text-muted min-h-[150px]" role="status"><span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />กำลังโหลดข้อมูลอุณหภูมิ</div>
          ) : temperatureQuery.isError ? (
            <div className="error-message rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">ไม่สามารถโหลดข้อมูลอุณหภูมิได้: {temperatureQuery.error.message}</div>
          ) : temperatureQuery.data && (
            <AnalyticsResult query={temperatureQuery} empty="ไม่มีข้อมูลอุณหภูมิในช่วงเวลานี้">
              {temperature.coverage && <div className="state-message rounded-xl border border-dashed border-border bg-surface-secondary p-4 text-sm leading-relaxed text-muted" role="status">{temperature.coverage}</div>}
              {temperature.scopeNote && <p className="mt-1.5 text-xs leading-relaxed text-muted">{temperature.scopeNote}</p>}
              <fieldset className="stat-grid stat-grid--cards mb-3 grid grid-cols-2 gap-2 md:mb-4 md:grid-cols-4">
                <legend className="sr-only">สรุปอุณหภูมิ</legend>
                <div><span>ค่าเฉลี่ย{temperature.coversFullRange ? "" : " (บางส่วน)"}</span><strong>{temperature.average === null ? "ไม่พร้อมใช้งาน" : `${temperature.average.toFixed(1)}°C`}</strong></div>
                <div><span>ต่ำสุด{temperature.coversFullRange ? "" : " (บางส่วน)"}</span><strong>{temperature.min === null ? "ไม่พร้อมใช้งาน" : `${temperature.min.toFixed(1)}°C`}</strong></div>
                <div><span>สูงสุด{temperature.coversFullRange ? "" : " (บางส่วน)"}</span><strong>{temperature.max === null ? "ไม่พร้อมใช้งาน" : `${temperature.max.toFixed(1)}°C`}</strong></div>
                <div><span>ค่าที่ไม่ทราบ</span><strong>{temperature.unknown}</strong></div>
              </fieldset>
              <DataTable headers={["เวลา", "เครื่อง", "อุณหภูมิ", "Phase"]}>
                {temperatureRows.slice(-8).reverse().map((row) => (
                  <tr key={`${row.machineId}-${row.occurredAt}-${row.phase}`}>
                    <td>{formatDateTime(row.occurredAt)}</td><td className="font-mono text-[11px] text-muted">{row.machineCode}</td><td className="font-mono tabular-nums whitespace-nowrap">{row.temperatureC === null ? "ไม่ทราบ" : `${row.temperatureC.toFixed(1)}°C`}</td><td>{row.phase || "ไม่ทราบ"}</td>
                  </tr>
                ))}
              </DataTable>
            </AnalyticsResult>
          )}
        </Card.Content>
      </Card>

      <Card variant="transparent" className="analytics-section rounded-xl border border-border bg-surface p-4 shadow-surface md:p-6 min-w-0">
        <Card.Content>
          <div className="flex flex-col items-start gap-1 md:flex-row md:items-baseline md:justify-between md:gap-3"><h2>ช่วงเวลาที่ไม่หนาแน่น</h2><span>สรุปจากช่วงวันที่ที่เลือกแล้ว ไม่ใช่การทำนาย</span></div>
          {offPeakQuery.isLoading ? (
            <div className="flex min-h-[60vh] items-center justify-center gap-2.5 text-sm text-muted min-h-[150px]" role="status"><span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />กำลังโหลดช่วงเวลา</div>
          ) : offPeakQuery.isError ? (
            <div className="error-message rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">ไม่สามารถโหลดช่วงเวลาได้: {offPeakQuery.error.message}</div>
          ) : offPeakQuery.data && (
            <AnalyticsResult query={offPeakQuery} empty={offPeakEmptyReason(offPeakQuery.data.meta.rules as unknown as OffPeakRules | undefined)}>
              <DataTable headers={["อันดับ", "วัน", "ช่วงเวลา", "รอบซัก", "เวลาใช้งาน"]}>
                {offPeakQuery.data.data.map((row) => (
                  <tr key={`${row.branchId}-${row.dayOfWeek}-${row.hourOfDay}`}>
                    <td className="font-mono tabular-nums whitespace-nowrap">{row.rank}</td>
                    <td>{weekdayLabel(row.weekday, row.dayOfWeek)}</td>
                    <td className="font-mono text-[11px] text-muted">{hourRangeLabel(row.hourOfDay)}</td>
                    <td className="font-mono tabular-nums whitespace-nowrap">{row.cycles.toLocaleString("th-TH")}</td>
                    <td className="font-mono tabular-nums whitespace-nowrap">{row.totalDurationMin.toLocaleString("th-TH", { maximumFractionDigits: 1 })} นาที</td>
                  </tr>
                ))}
              </DataTable>
            </AnalyticsResult>
          )}
        </Card.Content>
      </Card>

      <Card variant="transparent" className="analytics-section rounded-xl border border-border bg-surface p-4 shadow-surface md:p-6 min-w-0">
        <Card.Content>
          <div className="flex flex-col items-start gap-1 md:flex-row md:items-baseline md:justify-between md:gap-3"><h2>อากาศและรอบซัก</h2><span>ความสัมพันธ์เท่านั้น ไม่ใช่การทำนาย และตรวจสอบที่มาของข้อมูลอากาศไม่ได้</span></div>
          {weatherQuery.isLoading ? (
            <div className="flex min-h-[60vh] items-center justify-center gap-2.5 text-sm text-muted min-h-[150px]" role="status"><span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />กำลังโหลดข้อมูลอากาศ</div>
          ) : weatherQuery.isError ? (
            <div className="error-message rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">ไม่สามารถโหลดข้อมูลอากาศได้: {weatherQuery.error.message}</div>
          ) : weatherQuery.data && (
            <AnalyticsResult query={weatherQuery} empty="ไม่มีข้อมูลอากาศในช่วงวันที่ที่เลือก">
              <DataTable headers={["วันที่", "สาขา", "รอบซัก", "อุณหภูมิเฉลี่ย", "ความชื้น", "ปริมาณฝน", "ไม่มีค่า"]}>
                {weatherQuery.data.data.slice(-12).reverse().map((row) => (
                  <tr key={`${row.branchName}-${row.date}`}>
                    <td>{formatDate(row.date)}</td>
                    <td>{row.branchName}</td>
                    <td className="font-mono tabular-nums whitespace-nowrap">{row.cycles.toLocaleString("th-TH")}</td>
                    <td className="font-mono tabular-nums whitespace-nowrap">{row.avgTempC === null ? "ไม่ทราบ" : `${row.avgTempC.toFixed(1)}°C`}</td>
                    <td className="font-mono tabular-nums whitespace-nowrap">{row.avgHumidityPct === null ? "ไม่ทราบ" : `${row.avgHumidityPct.toFixed(0)}%`}</td>
                    <td className="font-mono tabular-nums whitespace-nowrap">{row.totalRainMm === null ? "ไม่ทราบ" : `${row.totalRainMm.toFixed(1)} มม.`}</td>
                    <td className="font-mono tabular-nums whitespace-nowrap">{row.missingTemp.toLocaleString("th-TH")}</td>
                  </tr>
                ))}
              </DataTable>
            </AnalyticsResult>
          )}
        </Card.Content>
      </Card>

      <section className="analytics-section min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <div><h2>การแจ้งเตือนและหลักฐาน</h2><p className="mt-1.5 text-xs leading-relaxed text-muted">รับทราบได้เฉพาะการแจ้งเตือนที่มีสาขาและอยู่ในขอบเขตของคุณ</p></div>
          {alertsQuery.data && <span className="source-pill inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent-soft-foreground">{sourceLabel(alertsQuery.data.source)}</span>}
        </div>
        {alertsQuery.isLoading && <div className="flex min-h-[60vh] items-center justify-center gap-2.5 text-sm text-muted min-h-[150px]" role="status"><span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />กำลังโหลดการแจ้งเตือน</div>}
        {alertsQuery.isError && <div className="error-message rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">ไม่สามารถโหลดการแจ้งเตือนได้: {alertsQuery.error.message}</div>}
        {alertsQuery.data && alertsQuery.data.availability === "unavailable" && (
          <div className="state-message rounded-xl border border-dashed border-border bg-surface-secondary p-4 text-sm leading-relaxed text-muted">{alertUnavailableReason(alertsQuery.data)}</div>
        )}
        {alertsQuery.data && alertsQuery.data.availability !== "unavailable" && alertsQuery.data.alerts.length === 0 && <div className="state-message rounded-xl border border-dashed border-border bg-surface-secondary p-4 text-sm leading-relaxed text-muted">ไม่มีการแจ้งเตือนในช่วงเวลานี้</div>}
        {alertsQuery.data && alertsQuery.data.availability !== "unavailable" && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted rounded-lg border border-border bg-surface-secondary px-3.5 py-3" aria-live="polite">
            <span>ดึงเมื่อ {formatDateTime(alertsQuery.data.fetchedAt)}</span>
            <strong>{formatDate(range.from)} — {formatDate(range.to)}</strong>
          </div>
        )}
        {acknowledgeMutation.isError && <div className="error-message rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">รับทราบการแจ้งเตือนไม่สำเร็จ: {acknowledgeMutation.error.message}</div>}
        {acknowledgeMutation.isSuccess && <div className="rounded-lg border border-border px-3.5 py-3 text-sm text-muted border-success/30 bg-success-soft text-success-soft-foreground" role="status">รับทราบการแจ้งเตือนแล้ว</div>}
        <div className="grid gap-2.5 md:gap-3">
          {alertsQuery.data?.alerts.map((alert) => (
            <AlertRow
              key={alert.id}
              alert={alert}
              pending={acknowledgeMutation.isPending && acknowledgeMutation.variables?.id === alert.id}
              onAcknowledge={() => {
                if (alert.branchId) acknowledgeMutation.mutate({ id: alert.id, branchId: alert.branchId });
              }}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function AnalyticsResult<T>({ query, empty, children }: { query: { data?: AnalyticsEnvelope<T>; dataUpdatedAt: number }; empty: string; children: React.ReactNode }) {
  const truncated = query.data?.meta.truncation;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted mb-4 rounded-lg border border-border bg-surface-secondary px-3 py-2.5" aria-live="polite">
        <span className="source-pill inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent-soft-foreground">{sourceLabel(query.data?.meta.dataSource ?? null)}</span>
        {query.data && (
          // A capped response must not be labelled with the full requested
          // range: that is exactly the claim the truncation notice retracts.
          <strong>
            {truncated ? "ช่วงที่ร้องขอ (ข้อมูลไม่ครบ)" : null}
            {truncated ? " " : null}
            {formatDate(query.data.meta.range.from)} — {formatDate(query.data.meta.range.to)}
          </strong>
        )}
        <span>โหลดข้อมูลเมื่อ {formatDateTime(query.dataUpdatedAt || null)}</span>
        {query.data?.meta.caveats?.map((caveat) => <span key={caveat}>{caveat}</span>)}
      </div>
      {query.data?.data.length ? children : <div className="state-message rounded-xl border border-dashed border-border bg-surface-secondary p-4 text-sm leading-relaxed text-muted">{empty}</div>}
    </>
  );
}

function DataTable({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <section className="w-full overflow-x-auto rounded-lg border border-border" aria-label={`ตาราง ${headers.join(" ")}`}>
      <table className="w-full border-collapse text-sm md:min-w-[620px]"><thead><tr>{headers.map((header) => <th key={header} scope="col" className="whitespace-nowrap">{header}</th>)}</tr></thead><tbody>{children}</tbody></table>
    </section>
  );
}

function AlertRow({ alert, pending, onAcknowledge }: { alert: Alert; pending: boolean; onAcknowledge: () => void }) {
  const severity = severityMeta(alert.severity);
  const acknowledged = Boolean(alert.acknowledgedLocally || alert.acknowledgedAt);
  const evidence = Object.keys(alert.evidence ?? {}).length > 0 ? JSON.stringify(alert.evidence) : "ไม่มีหลักฐานเพิ่มเติม";
  return (
    <Card variant="transparent" className="rounded-xl border border-border bg-surface p-4 shadow-surface md:p-6 rounded-xl border border-border bg-surface p-4 shadow-surface md:p-5">
      <Card.Content>
        <div className="flex items-start justify-between gap-5 max-[639px]:flex-col max-[639px]:gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2"><span className={`status-pill ${severity.className}`}>{severity.label}</span><h3>{alert.title}</h3></div>
            {alert.detail && <p>{alert.detail}</p>}
            <dl className="stat-grid mt-3 grid grid-cols-2 gap-2 md:mt-3.5 md:grid-cols-4">
              <div><dt>เครื่อง</dt><dd>{alert.machineId ?? "ไม่ระบุ"}</dd></div>
              <div><dt>กฎ</dt><dd>{alert.ruleId ?? "ไม่ระบุ"}</dd></div>
              <div><dt>เวอร์ชันกฎ</dt><dd>{alert.ruleVersion ?? "ไม่ระบุ"}</dd></div>
              <div><dt>ตรวจพบเมื่อ</dt><dd><time dateTime={alert.detectedAt}>{formatDateTime(alert.detectedAt)}</time></dd></div>
            </dl>
            <details className="mt-3"><summary>ดูหลักฐาน</summary><pre>{evidence}</pre></details>
            {alert.tags.length > 0 && <span className="font-mono text-[11px] text-muted">#{alert.tags.join(" #")}</span>}
          </div>
          <div className="grid flex-none justify-items-end gap-2 font-mono text-[11px] text-muted max-[639px]:justify-items-start">
            {acknowledged ? <span className="status-pill inline-flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-[11px] font-semibold leading-tight status-pill--success border-success/30 bg-success-soft text-success-soft-foreground">รับทราบแล้ว</span> : alert.branchId ? (
              <button type="button" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-default px-4 text-sm font-medium text-default-foreground transition-colors hover:bg-default-hover disabled:opacity-50" disabled={pending} onClick={onAcknowledge}>{pending ? "กำลังรับทราบ…" : "รับทราบ"}</button>
            ) : <span className="state-message rounded-xl border border-dashed border-border bg-surface-secondary p-4 text-sm leading-relaxed text-muted">ไม่มีสาขาสำหรับรับทราบ</span>}
          </div>
        </div>
      </Card.Content>
    </Card>
  );
}
