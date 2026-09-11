import { createFileRoute } from "@tanstack/react-router";
import { Button, Card, Input } from "@heroui/react";
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { apiUrl } from "../../lib/api/client";
import { authAtom } from "../../lib/atoms/auth";

export const Route = createFileRoute("/_authenticated/playground")({
  component: PlaygroundPage
});

type Grant = { id?: string; role: string; branchId: string | null };
type Branch = { id: string; code: string; name: string; timezone: string; status: string };
type Health = { ok: boolean; reportingConfigured: boolean; demoMode: boolean };

type Tab = "health" | "explorer" | "analytics";

function PlaygroundPage() {
  const [user] = useAtom(authAtom);
  const [activeTab, setActiveTab] = useState<Tab>("health");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiResponse, setApiResponse] = useState<{ status: number; data: unknown; duration: number } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testConfig, setTestConfig] = useState({ method: "GET", path: "/health", body: "" });

  useEffect(() => {
    fetch(apiUrl("/api/report/branches"), { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.branches) setBranches(d.branches);
      })
      .catch(() => {});
    fetch(apiUrl("/health"))
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ ok: false, reportingConfigured: false, demoMode: false }));
  }, []);

  async function runApiTest() {
    setIsTesting(true);
    setApiResponse(null);
    setError(null);
    const start = performance.now();
    try {
      const res = await fetch(apiUrl(testConfig.path), {
        method: testConfig.method,
        headers: { "content-type": "application/json" },
        body: testConfig.method !== "GET" && testConfig.body ? testConfig.body : undefined,
        credentials: "include"
      });
      const data = await res.json().catch(() => null);
      setApiResponse({ status: res.status, data, duration: Math.round(performance.now() - start) });
    } catch (nextError) {
      setApiResponse({ status: 0, data: { error: String(nextError) }, duration: Math.round(performance.now() - start) });
    } finally {
      setIsTesting(false);
    }
  }

  const grants: Grant[] = user?.grants ?? [];
  const roles = [...new Set(grants.map((g) => g.role))].join(" · ") || "No active access grant";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-default-400">Internal tools</p>
        <h1 className="text-2xl font-bold">Team Playground</h1>
        <p className="text-sm text-default-500">System health, API testing, and quick analytics queries</p>
      </div>

      <div className="flex gap-2" role="tablist" aria-label="Playground sections">
        {(["health", "explorer", "analytics"] as Tab[]).map((tab) => (
          <Button
            key={tab}
            variant={activeTab === tab ? "primary" : "ghost"}
            onPress={() => setActiveTab(tab)}
          >
            {tab === "health" ? "System Health" : tab === "explorer" ? "API Explorer" : "Analytics"}
          </Button>
        ))}
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {activeTab === "health" && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <HealthCard label="API Status" ok={health?.ok === true} value={health?.ok ? "Operational" : "Down"} note="Live check" />
          <HealthCard label="IRIS Reporting" ok={health?.reportingConfigured === true} value={health?.reportingConfigured ? "Configured" : "Not Configured"} note="Upstream source" />
          <HealthCard label="Demo Mode" ok={health?.demoMode === true} value={health?.demoMode ? "Enabled" : "Disabled"} note="Simulated data" />
          <HealthCard label="Branches" ok value={String(branches.length)} note="Accessible branches" />
          <HealthCard label="Your Role" ok value={roles} note="Auth grants" />
        </div>
      )}

      {activeTab === "explorer" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <div className="flex flex-col gap-3 p-4">
              <h3 className="font-semibold">Test API Endpoint</h3>
              <div className="flex gap-2">
                <select
                  className="rounded-lg border border-divider bg-background px-2 py-2 text-sm"
                  value={testConfig.method}
                  onChange={(e) => setTestConfig((c) => ({ ...c, method: e.target.value }))}
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="DELETE">DELETE</option>
                </select>
                <Input
                  className="flex-1"
                  placeholder="/api/report/branches"
                  value={testConfig.path}
                  onChange={(e) => setTestConfig((c) => ({ ...c, path: e.target.value }))}
                />
              </div>
              <label className="flex flex-col gap-1 text-sm">
                <span>Request Body (JSON)</span>
                <textarea
                  className="rounded-lg border border-divider bg-background p-2 font-mono text-xs"
                  value={testConfig.body}
                  onChange={(e) => setTestConfig((c) => ({ ...c, body: e.target.value }))}
                  rows={6}
                  placeholder='{ "key": "value" }'
                />
              </label>
              <Button variant="primary" onPress={() => void runApiTest()} isDisabled={isTesting}>
                {isTesting ? "Running…" : "Send Request"}
              </Button>
            </div>
          </Card>
          <Card>
            <div className="flex flex-col gap-2 p-4">
              <h3 className="font-semibold">Response</h3>
              {apiResponse ? (
                <>
                  <div className="flex items-center gap-2 text-sm">
                    <span className={apiResponse.status >= 200 && apiResponse.status < 300 ? "text-success" : "text-danger"}>
                      {apiResponse.status || "Network Error"}
                    </span>
                    <span className="text-default-400">{apiResponse.duration}ms</span>
                  </div>
                  <pre className="overflow-auto rounded-lg bg-default-100 p-3 text-xs">{JSON.stringify(apiResponse.data, null, 2)}</pre>
                </>
              ) : (
                <p className="text-sm text-default-400">No request sent yet</p>
              )}
            </div>
          </Card>
        </div>
      )}

      {activeTab === "analytics" && (
        <Card>
          <div className="flex flex-col gap-3 p-4">
            <h3 className="font-semibold">Quick Analytics Queries</h3>
            <p className="text-xs text-default-400">Pre-configured queries for common analytics endpoints</p>
            <div className="flex flex-wrap gap-2">
              {QUICK_QUERIES.map((q) => (
                <Button
                  key={q.label}
                  variant="ghost"
                  onPress={() => {
                    setTestConfig({ method: "GET", path: q.path, body: "" });
                    setActiveTab("explorer");
                  }}
                >
                  {q.label}
                </Button>
              ))}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function HealthCard({ label, ok, value, note }: { label: string; ok: boolean; value: string; note: string }) {
  return (
    <Card>
      <div className="flex flex-col gap-1 p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-default-400">{label}</span>
          <span className={`h-2 w-2 rounded-full ${ok ? "bg-success" : "bg-danger"}`} />
        </div>
        <strong className={ok ? "text-success" : "text-danger"}>{value}</strong>
        <small className="text-default-400">{note}</small>
      </div>
    </Card>
  );
}

function last7dQuery() {
  const to = new Date().toISOString().split("T")[0];
  const from = new Date(Date.now() - 7 * 864e5).toISOString().split("T")[0];
  return `?from=${from}&to=${to}`;
}

const QUICK_QUERIES = [
  { label: "Revenue (Last 7d)", path: `/api/v1/analytics/revenue/daily${last7dQuery()}` },
  { label: "Cycles (Last 7d)", path: `/api/v1/analytics/cycles/daily${last7dQuery()}` },
  { label: "Utilization Heatmap", path: `/api/v1/analytics/utilization/heatmap${last7dQuery()}` },
  { label: "Temperature Curve", path: `/api/v1/analytics/temperature/curve${last7dQuery()}` }
];
