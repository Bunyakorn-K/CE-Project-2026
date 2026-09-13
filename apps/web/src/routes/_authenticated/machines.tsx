import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiUrl } from "../../lib/api/client";

export const Route = createFileRoute("/_authenticated/machines")({
  component: MachinesPage
});

type Branch = { id: string; code: string; name: string; timezone: string; status: string };

type Machine = {
  id: string;
  code: string;
  kind: string;
  configuredStatus: string;
  state: string | null;
  remainingSeconds: number | null;
  lastSeen: string | null;
  freshness: "fresh" | "stale" | "unavailable";
  reason?: string;
  telemetry?: {
    phase: string | null;
    remainingSeconds: number | null;
    temperatureC: number | null;
    doorStatus: string | null;
    coinbox: string | null;
    paidSatang: number | null;
    errorCode: number | null;
  };
};

type LiveSnapshot = {
  contractVersion: string;
  source: string;
  fetchedAt: string;
  branchId: string;
  machines: Machine[];
};

function fmtRemaining(seconds: number | null): string {
  if (seconds === null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
}

function badgeClass(freshness: string, state: string | null): string {
  if (freshness === "stale") return "bg-warning/15 text-warning";
  if (freshness === "unavailable") return "bg-danger/15 text-danger";
  if (state === "running" || state === "washing" || state === "drying") return "bg-success/15 text-success";
  return "bg-default-100 text-default-500";
}

function MachinesPage() {
  const [branchId, setBranchId] = useState<string>("");

  const branchesQuery = useQuery({
    queryKey: ["report", "branches"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/report/branches"), { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { branches: Branch[] };
      return data.branches;
    }
  });

  const branches = branchesQuery.data ?? [];

  // /api/report/live requires a concrete branchId for every scope, so pick
  // the first accessible branch by default as soon as the list loads.
  useEffect(() => {
    if (!branchId && branches.length > 0) {
      setBranchId(branches[0].id);
    }
  }, [branches, branchId]);

  const liveQuery = useQuery({
    queryKey: ["report", "live", branchId],
    queryFn: async () => {
      const q = branchId ? `?branchId=${encodeURIComponent(branchId)}` : "";
      const res = await fetch(apiUrl(`/api/report/live${q}`), { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { live: LiveSnapshot };
      return data.live;
    },
    enabled: branchId !== ""
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Machines</h1>
          <p className="text-sm text-default-500">สถานะเครื่องซักผ้าแบบสด (Digital Twin)</p>
        </div>
        {branches.length > 1 && (
          <select
            className="rounded-lg border border-divider bg-background px-2 py-2 text-sm"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
          >
            <option value="">ทุกสาขา</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {liveQuery.isLoading && <p className="text-default-500">Loading machines…</p>}
      {liveQuery.error && (
        <Card>
          <div className="p-4 text-sm text-danger">
            ไม่สามารถโหลดข้อมูลเครื่องได้: {liveQuery.error.message}
          </div>
        </Card>
      )}

      {liveQuery.data && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-default-400">
            source: {liveQuery.data.source}
            {liveQuery.data.source === "demo" ? " (ข้อมูลจำลอง)" : ""} · fetched {fmtTime(liveQuery.data.fetchedAt)}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {liveQuery.data.machines.map((m) => (
              <Card key={m.id}>
                <div className="flex flex-col gap-2 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <strong>{m.code}</strong>
                      <p className="text-xs text-default-400">{m.kind}</p>
                    </div>
                    <span className={`rounded-full px-2 py-1 text-xs font-medium ${badgeClass(m.freshness, m.state)}`}>
                      {m.freshness === "fresh" ? (m.state ?? "unknown") : m.freshness}
                    </span>
                  </div>
                  {m.telemetry ? (
                    <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-sm">
                      <span className="text-default-500">Phase</span>
                      <span className="text-right">{m.telemetry.phase ?? "—"}</span>
                      <span className="text-default-500">เหลือเวลา</span>
                      <span className="text-right">{fmtRemaining(m.telemetry.remainingSeconds ?? m.remainingSeconds)}</span>
                      <span className="text-default-500">อุณหภูมิ</span>
                      <span className="text-right">{m.telemetry.temperatureC !== null ? `${m.telemetry.temperatureC}°C` : "—"}</span>
                      <span className="text-default-500">ประตู</span>
                      <span className="text-right">{m.telemetry.doorStatus ?? "—"}</span>
                      <span className="text-default-500">Coinbox</span>
                      <span className="text-right">{m.telemetry.coinbox ?? "—"}</span>
                      <span className="text-default-500">Error</span>
                      <span className="text-right">{m.telemetry.errorCode ?? "—"}</span>
                    </div>
                  ) : (
                    <p className="text-sm text-default-400">
                      {m.reason ?? "ไม่มี telemetry"}
                    </p>
                  )}
                  {m.lastSeen && (
                    <p className="text-xs text-default-400">last seen: {fmtTime(m.lastSeen)}</p>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
