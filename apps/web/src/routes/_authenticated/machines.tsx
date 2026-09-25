import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiErrorMessage, apiUrl } from "../../lib/api/client";

export const Route = createFileRoute("/_authenticated/machines")({
  component: MachinesPage
});

type Branch = { id: string; name: string; status: string };
type Machine = {
  id: string;
  code: string;
  kind: string;
  configuredStatus: string;
  state: string | null;
  remainingSeconds: number | null;
  lastSeen: string | null;
  freshness: "fresh" | "stale" | "unavailable" | string;
  reason?: string;
  telemetry?: {
    phase: string | null;
    remainingSeconds: number | null;
    temperatureC: number | null;
    doorStatus: string | null;
    coinbox: string | null;
    paidSatang: number | null;
    errorCode: number | null;
  } | null;
};
type LiveSnapshot = {
  contractVersion: string;
  source: string;
  fetchedAt: string;
  branchId: string;
  machines: Machine[];
};

async function fetchJson<T>(path: string, fallback: string): Promise<T> {
  const response = await fetch(apiUrl(path), { credentials: "include" });
  if (!response.ok) throw new Error(await apiErrorMessage(response, `${fallback} (HTTP ${response.status})`));
  return (await response.json()) as T;
}

function fmtRemaining(seconds: number | null): string {
  if (seconds === null) return "ไม่พร้อมใช้งาน";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes} นาที ${remainingSeconds.toString().padStart(2, "0")} วินาที`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "ไม่มีข้อมูล";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "ไม่มีข้อมูล";
  return date.toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function stateMeta(state: string | null): { label: string; className: string } {
  if (state === "running" || state === "washing" || state === "drying") return { label: "กำลังใช้งาน", className: "status-pill--success" };
  if (state === "paid") return { label: "ชำระแล้ว", className: "status-pill--warning" };
  if (state === "offline") return { label: "ออฟไลน์", className: "status-pill--danger" };
  if (state === "idle") return { label: "ว่าง", className: "status-pill--neutral" };
  if (state === "unknown") return { label: "ไม่ทราบสถานะ", className: "status-pill--neutral" };
  if (state) return { label: state, className: "status-pill--neutral" };
  return { label: "ไม่ทราบสถานะ", className: "status-pill--neutral" };
}

function freshnessMeta(freshness: string): { label: string; className: string } {
  if (freshness === "fresh") return { label: "สดตามแหล่งข้อมูล", className: "status-pill--success" };
  if (freshness === "stale") return { label: "ข้อมูลไม่สด", className: "status-pill--warning" };
  if (freshness === "unavailable") return { label: "ไม่พร้อมใช้งาน", className: "status-pill--danger" };
  return { label: `ความสดไม่ทราบ: ${freshness}`, className: "status-pill--neutral" };
}

function sourceLabel(source: string): string {
  if (source === "demo") return "โหมด Demo · ข้อมูลจำลอง";
  if (source === "postgres") return "แหล่งข้อมูล: IRIS/Postgres";
  if (source === "durable-object") return "แหล่งข้อมูล: Durable Object";
  if (source === "clickhouse") return "แหล่งข้อมูล: ClickHouse";
  return `แหล่งข้อมูล: ${source}`;
}

function MachinesPage() {
  const [branchId, setBranchId] = useState("");

  const branchesQuery = useQuery({
    queryKey: ["report", "branches", "machines"],
    queryFn: () => fetchJson<{ branches: Branch[] }>("/api/report/branches", "ไม่สามารถโหลดรายชื่อสาขาได้")
  });

  const branches = branchesQuery.data?.branches ?? [];

  useEffect(() => {
    if (!branchId && branches.length > 0) setBranchId(branches[0].id);
  }, [branchId, branches]);

  const liveQuery = useQuery({
    queryKey: ["report", "live", branchId],
    queryFn: async () => (await fetchJson<{ live: LiveSnapshot }>(`/api/report/live?branchId=${encodeURIComponent(branchId)}`, "ไม่สามารถโหลดข้อมูลเครื่องได้")).live,
    enabled: branchId !== "",
    refetchInterval: 60000
  });

  return (
    <div className="page-content">
      <section className="surface-card surface-card--dark">
        <div className="page-header">
          <div>
            <h1>สถานะเครื่องซักผ้า</h1>
            <p>ดู snapshot ล่าสุด แหล่งที่มา ความสด และค่าที่เครื่องรายงานโดยไม่อ้างว่าเป็นข้อมูลทันที</p>
          </div>
          {branches.length > 0 && (
            <div className="filter-field header-filter-field">
              <label htmlFor="machines-branch">สาขา</label>
              <select id="machines-branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
                {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </select>
            </div>
          )}
        </div>
      </section>

      {branchesQuery.isLoading && <div className="loading-state compact" role="status" aria-live="polite"><span className="loading-orbit" />กำลังโหลดสาขา</div>}
      {branchesQuery.isError && (
        <div className="error-message" role="alert">
          <span>ไม่สามารถโหลดรายชื่อสาขาได้: {branchesQuery.error.message}</span>
          <button type="button" className="secondary-button" onClick={() => void branchesQuery.refetch()}>ลองใหม่</button>
        </div>
      )}
      {branchesQuery.data && branches.length === 0 && <div className="state-message">ไม่มีสาขาที่บัญชีนี้ได้รับสิทธิ์</div>}
      {liveQuery.isLoading && <div className="loading-state compact" role="status" aria-live="polite"><span className="loading-orbit" />กำลังโหลด snapshot เครื่อง</div>}
      {liveQuery.isError && (
        <div className="error-message" role="alert">
          <span>ไม่สามารถโหลดข้อมูลเครื่องได้: {liveQuery.error.message}</span>
          <button type="button" className="secondary-button" onClick={() => void liveQuery.refetch()}>ลองใหม่</button>
        </div>
      )}

      {liveQuery.data && (
        <section>
          <div className="section-heading">
            <div>
              <h2>ภาพรวมเครื่อง</h2>
              <p className="section-description">รีเฟรช snapshot ทุก 60 วินาที ไม่ใช่ live feed</p>
            </div>
            <div className="data-context" aria-live="polite">
              <span className="source-pill">{sourceLabel(liveQuery.data.source)}</span>
              <span>ดึงเมื่อ {fmtTime(liveQuery.data.fetchedAt)}</span>
              {liveQuery.isFetching && <span>กำลังรีเฟรช</span>}
            </div>
          </div>
          {liveQuery.data.machines.length > 0 ? (
            <div className="machine-grid">{liveQuery.data.machines.map((machine) => <MachineCard key={machine.id} machine={machine} />)}</div>
          ) : (
            <div className="state-message">ไม่พบเครื่องในสาขานี้</div>
          )}
        </section>
      )}
    </div>
  );
}

function MachineCard({ machine }: { machine: Machine }) {
  const state = stateMeta(machine.state);
  const freshness = freshnessMeta(machine.freshness);
  return (
    <Card variant="transparent" className="surface-card machine-card">
      <Card.Content>
        <div className="machine-card-head">
          <div>
            <span className="machine-code">{machine.code}</span>
            <span className="machine-kind">{machine.kind === "washer" ? "เครื่องซักผ้า" : machine.kind === "dryer" ? "เครื่องอบผ้า" : machine.kind || "ไม่ระบุประเภท"}</span>
          </div>
          <span className={`status-pill ${state.className}`}>{state.label}</span>
        </div>
        <div className="machine-card-status-row">
          <span className={`status-pill ${freshness.className}`}>{freshness.label}</span>
          <span>สถานะตั้งค่า: {machine.configuredStatus || "ไม่ทราบ"}</span>
        </div>
        {machine.telemetry ? (
          <div className="machine-facts">
            <div><span>Phase</span><strong>{machine.telemetry.phase ?? "ไม่ทราบ"}</strong></div>
            <div><span>เหลือเวลา</span><strong>{fmtRemaining(machine.telemetry.remainingSeconds ?? machine.remainingSeconds)}</strong></div>
            <div><span>อุณหภูมิ</span><strong>{machine.telemetry.temperatureC === null ? "ไม่ทราบ" : `${machine.telemetry.temperatureC}°C`}</strong></div>
            <div><span>ประตู</span><strong>{machine.telemetry.doorStatus ?? "ไม่ทราบ"}</strong></div>
            <div><span>Coinbox</span><strong>{machine.telemetry.coinbox ?? "ไม่ทราบ"}</strong></div>
            <div><span>Error</span><strong>{machine.telemetry.errorCode === null ? "ไม่ทราบ" : machine.telemetry.errorCode}</strong></div>
          </div>
        ) : <div className="state-message">{machine.reason ?? "ไม่มี telemetry สำหรับเครื่องนี้"}</div>}
        <p className="kpi-detail">พบข้อมูลล่าสุด {fmtTime(machine.lastSeen)}</p>
      </Card.Content>
    </Card>
  );
}
