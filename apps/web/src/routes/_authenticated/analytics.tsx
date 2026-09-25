import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useState } from "react";
import { apiErrorMessage, apiUrl } from "../../lib/api/client";
import { authAtom } from "../../lib/atoms/auth";

export const Route = createFileRoute("/_authenticated/analytics")({
  component: AnalyticsPage
});

type SourceTag = "synthetic" | "real" | "mixed" | "empty";
type AnalyticsMeta = {
  range: { from: string; to: string };
  branchId: string | null;
  dataSource: SourceTag;
  caveats?: string[];
};
type AnalyticsEnvelope<T> = { meta: AnalyticsMeta; data: T[] };
type RevenueRow = { date: string; branchId: string; branchName: string; revenueSatang: number; cycles: number };
type CycleRow = { date: string; branchId: string; branchName: string; cycles: number; avgDurationMin: number };
type UtilizationRow = { hourBucket: string; machineId: string; machineCode: string; totalDurationMin: number; cycles: number };
type TemperatureRow = { occurredAt: string; machineId: string; machineCode: string; temperatureF: number | null; temperatureC: number | null; phase: string };
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
  const canViewRevenue = user?.grants.some((grant) => grant.role === "owner" || grant.role === "manager") ?? false;

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
  const validTemperatures = temperatureRows.flatMap((row) => row.temperatureC === null ? [] : [row.temperatureC]);
  const averageTemperature = validTemperatures.length > 0 ? validTemperatures.reduce((sum, value) => sum + value, 0) / validTemperatures.length : null;
  const utilizationRows = utilizationQuery.data?.data ?? [];
  const totalDuration = utilizationRows.reduce((sum, row) => sum + row.totalDurationMin, 0);
  const totalCycles = utilizationRows.reduce((sum, row) => sum + row.cycles, 0);

  return (
    <div className="page-content">
      <section className="surface-card surface-card--dark">
        <h1>พื้นที่วิเคราะห์ข้อมูล</h1>
        <p>ตรวจสอบรายได้ รอบซัก การใช้งาน อุณหภูมิ และหลักฐานการแจ้งเตือนในขอบเขตที่เซิร์ฟเวอร์อนุญาต</p>
      </section>

      <section className="filter-panel" aria-label="ตัวกรองข้อมูลวิเคราะห์">
        <div className="filter-field filter-field--branch">
          <label htmlFor="analytics-branch">สาขา</label>
          <select id="analytics-branch" value={branchId} disabled={branchesQuery.isLoading} onChange={(event) => setBranchId(event.target.value)}>
            <option value="">ทุกสาขาที่มีสิทธิ์</option>
            {(branchesQuery.data?.branches ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        </div>
        <div className="filter-field">
          <label htmlFor="analytics-from">ตั้งแต่วันที่</label>
          <input id="analytics-from" type="date" value={range.from} max={range.to} onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))} />
        </div>
        <div className="filter-field">
          <label htmlFor="analytics-to">ถึงวันที่</label>
          <input id="analytics-to" type="date" value={range.to} min={range.from} onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))} />
        </div>
        <p className="filter-note" role="status">เซิร์ฟเวอร์ตรวจสอบบทบาท สาขา และช่วงวันที่ซ้ำอีกครั้ง</p>
      </section>

      {!validRange && <div className="error-message">เลือกช่วงวันที่ให้ถูกต้องก่อนโหลดข้อมูล</div>}
      {branchesQuery.isError && <div className="error-message" role="alert">ไม่สามารถโหลดรายชื่อสาขาได้: {branchesQuery.error.message}</div>}

      <Card variant="transparent" className="surface-card analytics-section">
        <Card.Content>
          <div className="section-heading"><h2>รายได้รายวัน</h2><span>ต้องใช้บทบาท Owner หรือ Manager</span></div>
          {!canViewRevenue ? (
            <div className="state-message">ไม่มีสิทธิ์ดูรายได้ และไม่ได้ส่งคำขอ revenue ไปยังเซิร์ฟเวอร์</div>
          ) : revenueQuery.isLoading ? (
            <div className="loading-state compact" role="status"><span className="loading-orbit" />กำลังโหลดรายได้รายวัน</div>
          ) : revenueQuery.isError ? (
            <div className="error-message" role="alert">ไม่สามารถโหลดรายได้รายวันได้: {revenueQuery.error.message}</div>
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
                        <div className="data-bar-value"><strong>{baht(row.revenueSatang)}</strong><span>{percentage}% ของสูงสุดในชุดข้อมูล</span></div>
                        <div className="data-bar" role="progressbar" aria-label={`${row.branchName} ${formatDate(row.date)} รายได้ ${baht(row.revenueSatang)}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}><span style={{ width: `${percentage}%` }} /></div>
                      </td>
                      <td className="numeric-cell">{row.cycles.toLocaleString("th-TH")}</td>
                    </tr>
                  );
                })}
              </DataTable>
            </AnalyticsResult>
          )}
        </Card.Content>
      </Card>

      <Card variant="transparent" className="surface-card analytics-section">
        <Card.Content>
          <div className="section-heading"><h2>รอบซักและระยะเวลาเฉลี่ย</h2></div>
          {cyclesQuery.isLoading ? (
            <div className="loading-state compact" role="status"><span className="loading-orbit" />กำลังโหลดรอบซักรายวัน</div>
          ) : cyclesQuery.isError ? (
            <div className="error-message" role="alert">ไม่สามารถโหลดรอบซักรายวันได้: {cyclesQuery.error.message}</div>
          ) : cyclesQuery.data && (
            <AnalyticsResult query={cyclesQuery} empty="ไม่มีข้อมูลรอบซักในช่วงเวลานี้">
              <DataTable headers={["วันที่", "สาขา", "รอบซัก", "ระยะเวลาเฉลี่ย"]}>
                {cyclesQuery.data.data.map((row) => (
                  <tr key={`${row.branchId}-${row.date}`}>
                    <td>{formatDate(row.date)}</td><td>{row.branchName}</td><td className="numeric-cell">{row.cycles.toLocaleString("th-TH")}</td><td className="numeric-cell">{Number.isFinite(row.avgDurationMin) ? `${row.avgDurationMin.toFixed(1)} นาที` : "ไม่ทราบ"}</td>
                  </tr>
                ))}
              </DataTable>
            </AnalyticsResult>
          )}
        </Card.Content>
      </Card>

      <Card variant="transparent" className="surface-card analytics-section">
        <Card.Content>
          <div className="section-heading"><h2>สรุปการใช้งาน</h2><span>จากชั่วโมงและเครื่องที่มีข้อมูล</span></div>
          {utilizationQuery.isLoading ? (
            <div className="loading-state compact" role="status"><span className="loading-orbit" />กำลังโหลดข้อมูลการใช้งาน</div>
          ) : utilizationQuery.isError ? (
            <div className="error-message" role="alert">ไม่สามารถโหลดข้อมูลการใช้งานได้: {utilizationQuery.error.message}</div>
          ) : utilizationQuery.data && (
            <AnalyticsResult query={utilizationQuery} empty="ไม่มีข้อมูลการใช้งานในช่วงเวลานี้">
              <fieldset className="metric-strip">
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
                      <td>{formatDateTime(row.hourBucket)}</td><td className="data-code">{row.machineCode}</td>
                      <td><div className="data-bar-value"><strong>{row.totalDurationMin.toLocaleString("th-TH", { maximumFractionDigits: 1 })} นาที</strong></div><div className="data-bar" role="progressbar" aria-label={`${row.machineCode} ใช้งาน ${row.totalDurationMin} นาที`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}><span style={{ width: `${percentage}%` }} /></div></td>
                      <td className="numeric-cell">{row.cycles.toLocaleString("th-TH")}</td>
                    </tr>
                  );
                })}
              </DataTable>
            </AnalyticsResult>
          )}
        </Card.Content>
      </Card>

      <Card variant="transparent" className="surface-card analytics-section">
        <Card.Content>
          <div className="section-heading"><h2>สรุปอุณหภูมิ</h2><span>เฉพาะ sample ที่มีค่าอุณหภูมิ</span></div>
          {temperatureQuery.isLoading ? (
            <div className="loading-state compact" role="status"><span className="loading-orbit" />กำลังโหลดข้อมูลอุณหภูมิ</div>
          ) : temperatureQuery.isError ? (
            <div className="error-message" role="alert">ไม่สามารถโหลดข้อมูลอุณหภูมิได้: {temperatureQuery.error.message}</div>
          ) : temperatureQuery.data && (
            <AnalyticsResult query={temperatureQuery} empty="ไม่มีข้อมูลอุณหภูมิในช่วงเวลานี้">
              <fieldset className="metric-strip">
                <legend className="sr-only">สรุปอุณหภูมิ</legend>
                <div><span>ค่าเฉลี่ย</span><strong>{averageTemperature === null ? "ไม่พร้อมใช้งาน" : `${averageTemperature.toFixed(1)}°C`}</strong></div>
                <div><span>ต่ำสุด</span><strong>{validTemperatures.length > 0 ? `${Math.min(...validTemperatures).toFixed(1)}°C` : "ไม่พร้อมใช้งาน"}</strong></div>
                <div><span>สูงสุด</span><strong>{validTemperatures.length > 0 ? `${Math.max(...validTemperatures).toFixed(1)}°C` : "ไม่พร้อมใช้งาน"}</strong></div>
                <div><span>ค่าที่ไม่ทราบ</span><strong>{temperatureRows.length - validTemperatures.length}</strong></div>
              </fieldset>
              <DataTable headers={["เวลา", "เครื่อง", "อุณหภูมิ", "Phase"]}>
                {temperatureRows.slice(-8).reverse().map((row) => (
                  <tr key={`${row.machineId}-${row.occurredAt}-${row.phase}`}>
                    <td>{formatDateTime(row.occurredAt)}</td><td className="data-code">{row.machineCode}</td><td className="numeric-cell">{row.temperatureC === null ? "ไม่ทราบ" : `${row.temperatureC.toFixed(1)}°C`}</td><td>{row.phase || "ไม่ทราบ"}</td>
                  </tr>
                ))}
              </DataTable>
            </AnalyticsResult>
          )}
        </Card.Content>
      </Card>

      <section className="alert-section">
        <div className="section-heading">
          <div><h2>การแจ้งเตือนและหลักฐาน</h2><p className="section-description">รับทราบได้เฉพาะการแจ้งเตือนที่มีสาขาและอยู่ในขอบเขตของคุณ</p></div>
          {alertsQuery.data && <span className="source-pill">{sourceLabel(alertsQuery.data.source)}</span>}
        </div>
        {alertsQuery.isLoading && <div className="loading-state compact" role="status"><span className="loading-orbit" />กำลังโหลดการแจ้งเตือน</div>}
        {alertsQuery.isError && <div className="error-message" role="alert">ไม่สามารถโหลดการแจ้งเตือนได้: {alertsQuery.error.message}</div>}
        {alertsQuery.data && alertsQuery.data.availability === "unavailable" && <div className="state-message">{alertsQuery.data.reason ?? "แหล่งข้อมูลการแจ้งเตือนยังไม่พร้อมใช้งาน"}</div>}
        {alertsQuery.data && alertsQuery.data.availability !== "unavailable" && alertsQuery.data.alerts.length === 0 && <div className="state-message">ไม่มีการแจ้งเตือนในช่วงเวลานี้</div>}
        {alertsQuery.data && alertsQuery.data.availability !== "unavailable" && (
          <div className="data-context evidence-strip" aria-live="polite">
            <span>ดึงเมื่อ {formatDateTime(alertsQuery.data.fetchedAt)}</span>
            <strong>{formatDate(range.from)} — {formatDate(range.to)}</strong>
          </div>
        )}
        {acknowledgeMutation.isError && <div className="error-message" role="alert">รับทราบการแจ้งเตือนไม่สำเร็จ: {acknowledgeMutation.error.message}</div>}
        {acknowledgeMutation.isSuccess && <div className="feedback-message feedback-message--success" role="status">รับทราบการแจ้งเตือนแล้ว</div>}
        <div className="alert-stack">
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
  return (
    <>
      <div className="data-context analytics-meta" aria-live="polite">
        <span className="source-pill">{sourceLabel(query.data?.meta.dataSource ?? null)}</span>
        {query.data && <strong>{formatDate(query.data.meta.range.from)} — {formatDate(query.data.meta.range.to)}</strong>}
        <span>โหลดข้อมูลเมื่อ {formatDateTime(query.dataUpdatedAt || null)}</span>
        {query.data?.meta.caveats?.map((caveat) => <span key={caveat}>{caveat}</span>)}
      </div>
      {query.data?.data.length ? children : <div className="state-message">{empty}</div>}
    </>
  );
}

function DataTable({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <section className="table-scroll" aria-label={`ตาราง ${headers.join(" ")}`}>
      <table className="data-table"><thead><tr>{headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr></thead><tbody>{children}</tbody></table>
    </section>
  );
}

function AlertRow({ alert, pending, onAcknowledge }: { alert: Alert; pending: boolean; onAcknowledge: () => void }) {
  const severity = severityMeta(alert.severity);
  const acknowledged = Boolean(alert.acknowledgedLocally || alert.acknowledgedAt);
  const evidence = Object.keys(alert.evidence ?? {}).length > 0 ? JSON.stringify(alert.evidence) : "ไม่มีหลักฐานเพิ่มเติม";
  return (
    <Card variant="transparent" className="surface-card alert-row">
      <Card.Content>
        <div className="alert-row-head">
          <div>
            <div className="alert-row-title"><span className={`status-pill ${severity.className}`}>{severity.label}</span><h3>{alert.title}</h3></div>
            {alert.detail && <p>{alert.detail}</p>}
            <dl className="evidence-grid">
              <div><dt>เครื่อง</dt><dd>{alert.machineId ?? "ไม่ระบุ"}</dd></div>
              <div><dt>กฎ</dt><dd>{alert.ruleId ?? "ไม่ระบุ"}</dd></div>
              <div><dt>เวอร์ชันกฎ</dt><dd>{alert.ruleVersion ?? "ไม่ระบุ"}</dd></div>
              <div><dt>ตรวจพบเมื่อ</dt><dd><time dateTime={alert.detectedAt}>{formatDateTime(alert.detectedAt)}</time></dd></div>
            </dl>
            <details className="evidence-details"><summary>ดูหลักฐาน</summary><pre>{evidence}</pre></details>
            {alert.tags.length > 0 && <span className="data-code">#{alert.tags.join(" #")}</span>}
          </div>
          <div className="alert-row-meta">
            {acknowledged ? <span className="status-pill status-pill--success">รับทราบแล้ว</span> : alert.branchId ? (
              <button type="button" className="secondary-button" disabled={pending} onClick={onAcknowledge}>{pending ? "กำลังรับทราบ…" : "รับทราบ"}</button>
            ) : <span className="state-message">ไม่มีสาขาสำหรับรับทราบ</span>}
          </div>
        </div>
      </Card.Content>
    </Card>
  );
}
