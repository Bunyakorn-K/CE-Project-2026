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
    <div className="grid gap-4 md:gap-6">
      <section className="rounded-xl border border-border bg-surface p-4 shadow-surface md:p-6">
        <div className="page-header flex flex-col items-start gap-3 md:flex-row md:items-end md:justify-between md:gap-5">
          <div>
            <h1>สถานะเครื่องซักผ้า</h1>
            <p>ดู snapshot ล่าสุด แหล่งที่มา ความสด และค่าที่เครื่องรายงานโดยไม่อ้างว่าเป็นข้อมูลทันที</p>
          </div>
          {branches.length > 0 && (
            <div className="grid min-w-0 gap-1 text-xs font-medium text-muted md:gap-1.5 w-full max-w-[260px]">
              <label htmlFor="machines-branch">สาขา</label>
              <select id="machines-branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
                {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </select>
            </div>
          )}
        </div>
      </section>

      {branchesQuery.isLoading && <div className="flex min-h-[60vh] items-center justify-center gap-2.5 text-sm text-muted min-h-[150px]" role="status" aria-live="polite"><span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />กำลังโหลดสาขา</div>}
      {branchesQuery.isError && (
        <div className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground flex flex-wrap items-center gap-3" role="alert">
          <span>ไม่สามารถโหลดรายชื่อสาขาได้: {branchesQuery.error.message}</span>
          <button type="button" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-default px-4 text-sm font-medium text-default-foreground transition-colors hover:bg-default-hover disabled:opacity-50" onClick={() => void branchesQuery.refetch()}>ลองใหม่</button>
        </div>
      )}
      {branchesQuery.data && branches.length === 0 && <div className="rounded-xl border border-dashed border-border bg-surface-secondary p-4 text-sm leading-relaxed text-muted">ไม่มีสาขาที่บัญชีนี้ได้รับสิทธิ์</div>}
      {liveQuery.isLoading && <div className="flex min-h-[60vh] items-center justify-center gap-2.5 text-sm text-muted min-h-[150px]" role="status" aria-live="polite"><span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />กำลังโหลด snapshot เครื่อง</div>}
      {liveQuery.isError && (
        <div className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground flex flex-wrap items-center gap-3" role="alert">
          <span>ไม่สามารถโหลดข้อมูลเครื่องได้: {liveQuery.error.message}</span>
          <button type="button" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-default px-4 text-sm font-medium text-default-foreground transition-colors hover:bg-default-hover disabled:opacity-50" onClick={() => void liveQuery.refetch()}>ลองใหม่</button>
        </div>
      )}

      {liveQuery.data && (
        <section>
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <h2>ภาพรวมเครื่อง</h2>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">รีเฟรช snapshot ทุก 60 วินาที ไม่ใช่ live feed</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted" aria-live="polite">
              <span className="source-pill inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-accent-soft-foreground">{sourceLabel(liveQuery.data.source)}</span>
              <span>ดึงเมื่อ {fmtTime(liveQuery.data.fetchedAt)}</span>
              {liveQuery.isFetching && <span>กำลังรีเฟรช</span>}
            </div>
          </div>
          <StateSourceNotice machines={liveQuery.data.machines} />
          {liveQuery.data.machines.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">{liveQuery.data.machines.map((machine) => <MachineCard key={machine.id} machine={machine} />)}</div>
          ) : (
            <div className="rounded-xl border border-dashed border-border bg-surface-secondary p-4 text-sm leading-relaxed text-muted">ไม่พบเครื่องในสาขานี้</div>
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
    <Card variant="transparent" className="machine-card min-h-[168px] rounded-xl border border-border bg-surface p-4 shadow-surface md:p-5">
      <Card.Content>
        <div className="machine-card-head flex items-start justify-between gap-3">
          <div>
            <span className="mb-1 block text-xl font-semibold text-accent">{machine.code}</span>
            <span className="text-[11px] text-muted">{machineKindLabel(machine.kind)}</span>
          </div>
          <span className={`status-pill ${claim.className}`}>{claim.label}</span>
        </div>
        <div className="machine-card-status-row mt-3.5 flex flex-wrap items-center gap-2 text-[11px] text-muted">
          {freshness && <span className={`status-pill ${freshness.className}`}>{freshness.label}</span>}
          <span>สถานะตั้งค่า: {machine.configuredStatus || "ไม่ทราบ"}</span>
        </div>
        {machine.telemetry ? (
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-3.5">
            <div className="flex flex-col gap-0.5"><span className="text-[11px] text-muted">Phase</span><strong className="text-sm">{machine.telemetry.phase ?? "ไม่ทราบ"}</strong></div>
            <div className="flex flex-col gap-0.5"><span className="text-[11px] text-muted">เหลือเวลา</span><strong className="text-sm">{fmtRemaining(machine.telemetry.remainingSeconds ?? machine.remainingSeconds)}</strong></div>
            <div className="flex flex-col gap-0.5"><span className="text-[11px] text-muted">อุณหภูมิ</span><strong className="text-sm">{machine.telemetry.temperatureC === null ? "ไม่ทราบ" : `${machine.telemetry.temperatureC}°C`}</strong></div>
            <div className="flex flex-col gap-0.5"><span className="text-[11px] text-muted">ประตู</span><strong className="text-sm">{machine.telemetry.doorStatus ?? "ไม่ทราบ"}</strong></div>
            <div className="flex flex-col gap-0.5"><span className="text-[11px] text-muted">Coinbox</span><strong className="text-sm">{machine.telemetry.coinbox ?? "ไม่ทราบ"}</strong></div>
            <div className="flex flex-col gap-0.5"><span className="text-[11px] text-muted">Error</span><strong className="text-sm">{machine.telemetry.errorCode === null ? "ไม่ทราบ" : machine.telemetry.errorCode}</strong></div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border bg-surface-secondary p-4 text-sm leading-relaxed text-muted">
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
            {claim.kind === "withheld" && claim.recordedLabel && <span className="text-muted"> · {claim.recordedLabel}</span>}
          </div>
        )}
        <p className="mt-2 block text-xs text-muted">พบข้อมูลล่าสุด {fmtTime(machine.lastSeen)}</p>
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
    <div className="machine-source-notice rounded-xl border border-dashed border-border bg-surface-secondary p-4 text-sm leading-relaxed text-muted mt-3.5" role="status">
      {/* Thai first. The server's own reason stays available per machine on the
          card, but the headline explanation is this product's own claim about
          what it can and cannot see. */}
      ไม่มีข้อมูลสดจากเครื่อง · สถานะทั้งหมดด้านล่างคำนวณจากแถวการใช้งาน ไม่ใช่ค่าที่เครื่องรายงานขณะนี้
    </div>
  );
}
