import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiErrorMessage, apiUrl } from "../../lib/api/client";
import { freshnessMeta } from "../../lib/machine-status";
import { liveFreshnessRow, liveStateSource, liveStatusClaim, machineKindLabel } from "../../lib/live-machine-view";
import { machineAvailability } from "../../lib/branch-availability-view";

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
  /**
   * Whether the BRANCH is trading right now. Absent on an older API build,
   * which renders exactly what it renders today — see
   * `machineAvailability` for why absent must never be read as "closed".
   */
  branchOpenState?: string;
  /**
   * Whether this snapshot's state came from live telemetry or from usage rows.
   * Absent on an older API build, which is why `liveStateSource` treats missing
   * coverage as "no claim" rather than "unavailable".
   */
  coverage?: { liveState?: { available: boolean; reason?: string } };
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
        <div className="error-message flex flex-wrap items-center gap-3" role="alert">
          <span>ไม่สามารถโหลดรายชื่อสาขาได้: {branchesQuery.error.message}</span>
          <button type="button" className="secondary-button" onClick={() => void branchesQuery.refetch()}>ลองใหม่</button>
        </div>
      )}
      {branchesQuery.data && branches.length === 0 && <div className="state-message">ไม่มีสาขาที่บัญชีนี้ได้รับสิทธิ์</div>}
      {liveQuery.isLoading && <div className="loading-state compact" role="status" aria-live="polite"><span className="loading-orbit" />กำลังโหลด snapshot เครื่อง</div>}
      {liveQuery.isError && (
        <div className="error-message flex flex-wrap items-center gap-3" role="alert">
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
          <StateSourceNotice machines={liveQuery.data.machines} />
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
  const claim = liveStatusClaim(machine);
  // The pill shows the AVAILABILITY, not the raw evidence age: a shut branch
  // produces no usage rows, and without this the page renders all 19 machines
  // red `ไม่พร้อมใช้งาน` for a shop that is simply closed. `liveStatusClaim`
  // keeps reading the raw freshness, so a closed branch still WITHHOLDS the
  // machine state — a shut branch is not evidence the machine is idle.
  const availability = machineAvailability(machine.freshness, machine.branchOpenState);
  const freshness = liveFreshnessRow(availability);
  const fallback = freshnessMeta(availability);
  return (
    <Card variant="transparent" className="surface-card machine-card">
      <Card.Content>
        <div className="machine-card-head">
          <div>
            <span className="machine-code">{machine.code}</span>
            <span className="machine-kind">{machineKindLabel(machine.kind)}</span>
          </div>
          <span className={`status-pill ${claim.className}`}>{claim.label}</span>
        </div>
        <div className="machine-card-status-row">
          {freshness && <span className={`status-pill ${freshness.className}`}>{freshness.label}</span>}
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
        ) : (
          <div className="state-message">
            {/* Thai from the freshness enum rather than the server's English
                prose. An unrecognised freshness value falls back to the
                server's own reason -- showing the source string beats guessing
                at a cause this build does not model. */}
            {fallback.known
              ? fallback.reason
              : machine.reason ?? "ไม่มี telemetry สำหรับเครื่องนี้"}
            {/* The withheld state keeps its history visible without promoting it
                back to the headline. A card that says only "unknown" would make
                a technician re-check a machine it can already answer. */}
            {claim.kind === "withheld" && claim.recordedLabel && <span className="machine-recorded-state"> · {claim.recordedLabel}</span>}
          </div>
        )}
        <p className="kpi-detail">พบข้อมูลล่าสุด {fmtTime(machine.lastSeen)}</p>
      </Card.Content>
    </Card>
  );
}

/**
 * One statement of where this snapshot's state came from, above the grid.
 *
 * Every machine carries `coverage.liveState`, and the page used to read none of
 * it — so the page whose entire subject is machine state never said that it has
 * none. Stating it once here beats stamping the same sentence onto 19 cards.
 */
function StateSourceNotice({ machines }: { machines: Machine[] }) {
  const sources = machines.map((machine) => liveStateSource(machine.coverage));
  // An older build carries no coverage on any machine. Saying nothing keeps the
  // three states distinct: no claim, source missing, source working. The notice
  // is only true when *every* machine agrees, so a mixed payload claims nothing.
  if (sources.length === 0) return null;
  if (!sources.every((source) => !("known" in source) && !source.available)) return null;
  return (
    <div className="state-message machine-source-notice" role="status">
      {/* Thai first. The server's own reason stays available per machine on the
          card, but the headline explanation is this product's own claim about
          what it can and cannot see. */}
      ไม่มีข้อมูลสดจากเครื่อง · สถานะทั้งหมดด้านล่างคำนวณจากแถวการใช้งาน ไม่ใช่ค่าที่เครื่องรายงานขณะนี้
    </div>
  );
}
