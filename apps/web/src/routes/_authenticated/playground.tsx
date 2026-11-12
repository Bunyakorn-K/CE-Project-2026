import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useState } from "react";
import { apiErrorMessage, apiUrl } from "../../lib/api/client";
import { authAtom } from "../../lib/atoms/auth";
import { isOwner as hasOwnerGrant } from "../../lib/access";
import { branchScopeState, branchScopeView } from "../../lib/branch-scope";

export const Route = createFileRoute("/_authenticated/playground")({
  component: PlaygroundPage
});

type Branch = { id: string; name: string; status: string };
type Health = { ok: boolean; reportingConfigured: boolean; demoMode: boolean };
type Tab = "health" | "analytics";
type CheckKey = "revenue" | "cycles" | "utilization" | "temperature";

type AnalyticsEnvelope = { meta: { range: { from: string; to: string }; branchId: string | null; dataSource: string; caveats?: string[] }; data: unknown[] };

const CHECKS: Array<{ key: CheckKey; label: string; path: string }> = [
  { key: "revenue", label: "รายได้รายวัน", path: "/api/v1/analytics/revenue/daily" },
  { key: "cycles", label: "รอบซักรายวัน", path: "/api/v1/analytics/cycles/daily" },
  { key: "utilization", label: "แผนผังการใช้งาน", path: "/api/v1/analytics/utilization/heatmap" },
  { key: "temperature", label: "เส้นอุณหภูมิ", path: "/api/v1/analytics/temperature/curve" }
];

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

async function fetchJson<T>(path: string, fallback: string): Promise<T> {
  const response = await fetch(apiUrl(path), { credentials: "include" });
  if (!response.ok) throw new Error(await apiErrorMessage(response, `${fallback} (HTTP ${response.status})`));
  return (await response.json()) as T;
}

function PlaygroundPage() {
  const [user] = useAtom(authAtom);
  const isOwner = hasOwnerGrant(user);
  const [tab, setTab] = useState<Tab>("health");
  const [check, setCheck] = useState<CheckKey>("cycles");
  const [branchId, setBranchId] = useState("");
  const [range, setRange] = useState(recentRange);

  const healthQuery = useQuery({
    queryKey: ["playground", "health"],
    queryFn: () => fetchJson<Health>("/health", "ไม่สามารถตรวจสอบ health ได้"),
    enabled: isOwner
  });

  const branchesQuery = useQuery({
    queryKey: ["report", "branches", "playground"],
    queryFn: () => fetchJson<{ branches: Branch[] }>("/api/report/branches", "ไม่สามารถโหลดรายชื่อสาขาได้"),
    enabled: isOwner
  });

  const branchScope = branchScopeState({
    isError: branchesQuery.isError,
    isLoading: branchesQuery.isLoading,
    branchCount: branchesQuery.data?.branches.length
  });
  const branchScopeCard = branchScopeView(branchScope);

  const selectedCheck = CHECKS.find((item) => item.key === check) ?? CHECKS[1];
  const checkQuery = useQuery({
    queryKey: ["playground", "analytics", check, branchId, range.from, range.to],
    queryFn: () => {
      const params = new URLSearchParams({ from: range.from, to: range.to });
      if (branchId) params.set("branchId", branchId);
      return fetchJson<AnalyticsEnvelope>(`${selectedCheck.path}?${params.toString()}`, "ไม่สามารถตรวจสอบ analytics ได้");
    },
    enabled: isOwner && tab === "analytics" && Boolean(range.from && range.to && range.from <= range.to)
  });

  if (!isOwner) {
    return (
      <div className="grid gap-6">
        <section className="rounded-xl border border-border bg-surface p-6 shadow-surface grid justify-items-start gap-3 p-6">
          <h1>เข้าถึงไม่ได้</h1>
          <p>Playground นี้เปิดให้เฉพาะเจ้าของ เพราะเป็นพื้นที่ตรวจสอบระบบภายใน</p>
          <Link to="/dashboard" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-default px-4 text-sm font-medium text-default-foreground transition-colors hover:bg-default-hover disabled:opacity-50 w-fit">กลับภาพรวม</Link>
        </section>
      </div>
    );
  }

  const roles = Array.from(new Set((user?.grants ?? []).map((grant) => grant.role))).join(" · ");

  return (
    <div className="grid gap-6">
      <section className="rounded-xl border border-border bg-surface p-6 shadow-surface">
        <div className="page-header flex items-end justify-between gap-5 max-[639px]:flex-col max-[639px]:items-start">
          <div>
            <h1>Playground ระบบ</h1>
            <p>ตรวจสอบ health และ allow-listed analytics เท่านั้น · ไม่มี API explorer และไม่มีการรัน SQL อิสระ</p>
          </div>
        </div>
      </section>

      <div className="flex w-full max-w-[300px] items-center gap-1.5 max-w-[560px]" role="tablist" aria-label="Playground sections">
        <button type="button" role="tab" id="playground-health-tab" aria-controls="playground-health-panel" aria-selected={tab === "health"} className={tab === "health" ? "is-active" : ""} onClick={() => setTab("health")}>ตรวจสอบระบบ</button>
        <button type="button" role="tab" id="playground-analytics-tab" aria-controls="playground-analytics-panel" aria-selected={tab === "analytics"} className={tab === "analytics" ? "is-active" : ""} onClick={() => setTab("analytics")}>Allow-listed analytics</button>
      </div>

      {tab === "health" && (
        <section id="playground-health-panel" role="tabpanel" aria-labelledby="playground-health-tab" className="rounded-xl border border-border bg-surface p-6 shadow-surface min-w-0">
          {healthQuery.isLoading && <div className="flex min-h-[60vh] items-center justify-center gap-2.5 text-sm text-muted min-h-[150px]" role="status"><span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />กำลังตรวจสอบ health</div>}
          {healthQuery.isError && <div className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">ไม่สามารถตรวจสอบ health ได้: {healthQuery.error.message}</div>}
          {healthQuery.data && <div className="grid grid-cols-3 gap-4 max-[1023px]:grid-cols-2 max-[639px]:grid-cols-1">
            <HealthCard label="API" value={healthQuery.data.ok ? "ทำงาน" : "ไม่ทำงาน"} status={healthQuery.data.ok ? "พร้อมใช้งาน" : "ไม่พร้อมใช้งาน"} tone={healthQuery.data.ok ? "success" : "danger"} />
            <HealthCard label="ระบบรายงาน" value={healthQuery.data.reportingConfigured ? "ตั้งค่าแล้ว" : "ยังไม่ตั้งค่า"} status={healthQuery.data.reportingConfigured ? "พร้อมใช้งาน" : "ไม่พร้อมใช้งาน"} tone={healthQuery.data.reportingConfigured ? "success" : "warning"} />
            <HealthCard label="โหมด Demo" value={healthQuery.data.demoMode ? "เปิดอยู่" : "ปิดอยู่"} status={healthQuery.data.demoMode ? "ข้อมูลจำลอง" : "ข้อมูลจริงตามการตั้งค่า"} tone={healthQuery.data.demoMode ? "warning" : "neutral"} />
            <HealthCard label="สาขาที่เข้าถึงได้" value={branchScopeCard.value} status={branchScopeCard.status} tone={branchScopeCard.tone} />
            <HealthCard label="บทบาท" value={roles || "ไม่มี grant"} status="จาก /api/me" tone="neutral" />
          </div>}
          {branchesQuery.isError && <div className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">ไม่สามารถโหลดรายชื่อสาขาได้: {branchesQuery.error.message}</div>}
        </section>
      )}

      {tab === "analytics" && (
        <section id="playground-analytics-panel" role="tabpanel" aria-labelledby="playground-analytics-tab" className="rounded-xl border border-border bg-surface p-6 shadow-surface min-w-0">
          <div className="flex items-baseline justify-between gap-3"><h2>ตรวจสอบ allow-listed endpoint</h2><span>ใช้เฉพาะ GET และ query ที่ระบบกำหนด</span></div>
          <div className="grid gap-3 rounded-xl border border-border bg-surface p-4 shadow-surface md:grid-cols-4 mb-4">
            <div className="grid min-w-0 gap-1.5 text-xs font-medium text-muted"><label htmlFor="playground-check">ชุดข้อมูล</label><select id="playground-check" value={check} onChange={(event) => setCheck(event.target.value as CheckKey)}>{CHECKS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></div>
            <div className="grid min-w-0 gap-1.5 text-xs font-medium text-muted"><label htmlFor="playground-branch">สาขา</label><select id="playground-branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">ทุกสาขาที่มีสิทธิ์</option>{(branchesQuery.data?.branches ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></div>
            <div className="grid min-w-0 gap-1.5 text-xs font-medium text-muted"><label htmlFor="playground-from">ตั้งแต่วันที่</label><input id="playground-from" type="date" value={range.from} max={range.to} onChange={(event) => setRange((current) => ({ ...current, from: event.target.value }))} /></div>
            <div className="grid min-w-0 gap-1.5 text-xs font-medium text-muted"><label htmlFor="playground-to">ถึงวันที่</label><input id="playground-to" type="date" value={range.to} min={range.from} onChange={(event) => setRange((current) => ({ ...current, to: event.target.value }))} /></div>
          </div>
          {checkQuery.isLoading && <div className="flex min-h-[60vh] items-center justify-center gap-2.5 text-sm text-muted min-h-[150px]" role="status"><span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />กำลังตรวจสอบ {selectedCheck.label}</div>}
          {checkQuery.isError && <div className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">ไม่สามารถตรวจสอบ {selectedCheck.label} ได้: {checkQuery.error.message}</div>}
          {checkQuery.data && <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted mb-4 rounded-lg border border-border bg-surface-secondary px-3 py-2.5"><span className="source-pill inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent-soft-foreground">แหล่งข้อมูล: {checkQuery.data.meta.dataSource}</span><strong>{checkQuery.data.meta.range.from} — {checkQuery.data.meta.range.to}</strong><span>แถวที่ได้: {checkQuery.data.data.length}</span></div>
            {checkQuery.data.data.length === 0 ? <div className="rounded-xl border border-dashed border-border bg-surface-secondary p-4 text-sm leading-relaxed text-muted">ไม่มีข้อมูลในช่วงเวลานี้</div> : <pre className="mt-2 max-w-full overflow-auto rounded-lg border border-border bg-surface-secondary p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">{JSON.stringify(checkQuery.data, null, 2)}</pre>}
          </>}
        </section>
      )}
    </div>
  );
}

function HealthCard({ label, value, status, tone }: { label: string; value: string; status: string; tone: "success" | "warning" | "danger" | "neutral" }) {
  return <div className="grid content-start gap-2 rounded-xl border border-border bg-surface p-4 shadow-surface"><span>{label}</span><strong>{value}</strong><span className={`status-pill status-pill--${tone}`}>{status}</span></div>;
}
