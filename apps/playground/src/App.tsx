import { useEffect, useState } from "react";
import { connectLiff } from "./liff";

type Role = "owner" | "manager" | "technician";
type Grant = { id: string; role: Role; branchId: string | null };
type Branch = { id: string; code: string; name: string; timezone: string; status: string };

type Me = { user: { id: string; name: string; email: string }; source: "better-auth" | "liff" | "demo"; grants: Grant[] };

class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...init });
  const payload = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | T | null;
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new ApiError(error?.message ?? "The request could not be completed", response.status, error?.code);
  }
  return payload as T;
}

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [demoMode, setDemoMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadAccess() {
    setError(null);
    try {
      const nextMe = await request<Me>("/api/me");
      setMe(nextMe);
      try {
        const branchResponse = await request<{ branches: Branch[] }>("/api/report/branches");
        setBranches(branchResponse.branches);
      } catch (nextError) {
        setBranches([]);
        setError(messageForError(nextError));
      }
    } catch (nextError) {
      if (nextError instanceof ApiError && nextError.status === 401) {
        setMe(null);
        return;
      }
      setMe(null);
      setError(messageForError(nextError));
    }
  }

  useEffect(() => {
    void loadAccess();
  }, []);

  useEffect(() => {
    void request<{ demoMode: boolean }>("/health")
      .then((health) => setDemoMode(health.demoMode))
      .catch(() => setDemoMode(false));
  }, []);

  if (me === undefined) {
    return <LoadingScreen label="กำลังตรวจสอบสิทธิ์การเข้าถึง" />;
  }

  if (me === null) {
    return <AccessScreen demoEnabled={demoMode} error={error} onAuthenticated={loadAccess} />;
  }

  return (
    <main id="top">
      <Header me={me} onSignOut={async () => {
        await request("/api/auth/liff/logout", { method: "POST" });
        setMe(null);
      }} />
      <div className="page-shell">
        {error ? <SourceMessage message={error} /> : null}
        <PlaygroundScreen me={me} branches={branches} />
      </div>
    </main>
  );
}

function Header({ me, onSignOut }: { me: Me; onSignOut: () => Promise<void> }) {
  return (
    <>
      <header className="topbar">
        <div className="brand" aria-label="LaundryTwin team playground">
          <span className="brand-mark" aria-hidden="true">◇</span>
          <span>
            <strong>LaundryTwin</strong>
            <small>Team playground</small>
          </span>
        </div>
        <div className="topbar-actions">
          <button className="account-button" onClick={onSignOut}>{me.user.name} · ออก</button>
        </div>
      </header>
    </>
  );
}

type Tab = "health" | "explorer" | "analytics";

function PlaygroundScreen({ me, branches }: { me: Me; branches: Branch[] }) {
  const [activeTab, setActiveTab] = useState<Tab>("health");
  const [health, setHealth] = useState<{ ok: boolean; reportingConfigured: boolean; demoMode: boolean } | null>(null);
  const [apiResponse, setApiResponse] = useState<{ status: number; data: unknown; duration: number } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testConfig, setTestConfig] = useState({ method: "GET", path: "/health", body: "" });

  useEffect(() => {
    fetch("/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ ok: false, reportingConfigured: false, demoMode: false }));
  }, []);

  async function runApiTest() {
    setIsTesting(true);
    setApiResponse(null);
    const start = performance.now();
    try {
      const res = await fetch(testConfig.path, {
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

  return (
    <div className="playground">
      <section className="playground-header">
        <p className="eyebrow">Internal tools</p>
        <h1>Team Playground</h1>
        <p>LaundryTwin internal dashboard for team exploration and API testing</p>
      </section>

      <nav className="playground-tabs" aria-label="Playground sections">
        <button className={activeTab === "health" ? "tab active" : "tab"} onClick={() => setActiveTab("health")}>System Health</button>
        <button className={activeTab === "explorer" ? "tab active" : "tab"} onClick={() => setActiveTab("explorer")}>API Explorer</button>
        <button className={activeTab === "analytics" ? "tab active" : "tab"} onClick={() => setActiveTab("analytics")}>Analytics</button>
      </nav>

      {activeTab === "health" && (
        <section className="playground-section">
          <div className="health-grid">
            <HealthCard label="API Status" ok={health?.ok === true} value={health?.ok ? "Operational" : "Down"} note="Live check" />
            <HealthCard label="IRIS Reporting" ok={health?.reportingConfigured === true} value={health?.reportingConfigured ? "Configured" : "Not Configured"} note="Upstream source" />
            <HealthCard label="Demo Mode" ok={health?.demoMode === true} value={health?.demoMode ? "Enabled" : "Disabled"} note="Simulated data" />
            <HealthCard label="Branches" ok value={String(branches.length)} note="Accessible branches" />
            <HealthCard label="Your Role" ok value={roleText(me.grants)} note={`Auth: ${me.source}`} />
          </div>

          <div className="section-block">
            <div className="section-heading">
              <div><p className="eyebrow">Endpoints</p><h2>Available API Routes</h2></div>
            </div>
            <div className="endpoint-list">
              {ENDPOINTS.map((ep) => (
                <div key={ep.path} className="endpoint-row">
                  <span className={`ep-method ${ep.method.toLowerCase()}`}>{ep.method}</span>
                  <code className="ep-path">{ep.path}</code>
                  <span className="ep-desc">{ep.desc}</span>
                  <span className={ep.auth ? "ep-auth required" : "ep-auth public"}>{ep.auth ? "Auth required" : "Public"}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {activeTab === "explorer" && (
        <section className="playground-section">
          <div className="explorer-grid">
            <div className="explorer-form card">
              <h3>Test API Endpoint</h3>
              <div className="form-row">
                <select
                  value={testConfig.method}
                  onChange={(e) => setTestConfig((c) => ({ ...c, method: e.target.value }))}
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="DELETE">DELETE</option>
                </select>
                <input
                  value={testConfig.path}
                  onChange={(e) => setTestConfig((c) => ({ ...c, path: e.target.value }))}
                  placeholder="/api/report/branches"
                />
              </div>
              <label>Request Body (JSON)</label>
              <textarea
                value={testConfig.body}
                onChange={(e) => setTestConfig((c) => ({ ...c, body: e.target.value }))}
                rows={6}
                placeholder='{ "key": "value" }'
              />
              <button className="primary" onClick={runApiTest} disabled={isTesting}>
                {isTesting ? "Running..." : "Send Request"}
              </button>
            </div>

            <div className="api-response card">
              <h3>Response</h3>
              {apiResponse ? (
                <>
                  <div className="response-meta">
                    <span className={`response-status ${apiResponse.status >= 200 && apiResponse.status < 300 ? "success" : "error"}`}>
                      {apiResponse.status || "Network Error"}
                    </span>
                    <span className="response-time">{apiResponse.duration}ms</span>
                  </div>
                  <pre>{JSON.stringify(apiResponse.data, null, 2)}</pre>
                </>
              ) : (
                <p className="empty-state">No request sent yet</p>
              )}
            </div>
          </div>
        </section>
      )}

      {activeTab === "analytics" && (
        <section className="playground-section">
          <div className="analytics-quick">
            <h3>Quick Analytics Queries</h3>
            <p className="eyebrow">Pre-configured queries for common analytics endpoints</p>
            <div className="analytics-buttons">
              {QUICK_QUERIES.map((q) => (
                <button key={q.label} className="secondary" onClick={async () => {
                  setTestConfig({ method: "GET", path: q.path, body: "" });
                  setActiveTab("explorer");
                  await runApiTest();
                }}>
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function HealthCard({ label, ok, value, note }: { label: string; ok: boolean; value: string; note: string }) {
  return (
    <div className={`health-card card ${ok ? "healthy" : "unhealthy"}`}>
      <div className="health-card-top">
        <span className="health-label">{label}</span>
        <span className={`status-dot ${ok ? "healthy" : "unhealthy"}`} />
      </div>
      <strong className={ok ? "status-ok" : "status-down"}>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

function AccessScreen({ demoEnabled, error, onAuthenticated }: { demoEnabled: boolean; error: string | null; onAuthenticated: () => Promise<void> }) {
  const liffId = import.meta.env.VITE_LIFF_ID as string | undefined;
  const [message, setMessage] = useState(error);
  const [pending, setPending] = useState(false);

  async function signInWithLine() {
    if (!liffId) {
      setMessage("ยังไม่ได้ตั้งค่า VITE_LIFF_ID สำหรับ LINE LIFF");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const identity = await connectLiff(liffId);
      if (!identity) return;
      await request("/api/auth/liff/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken: identity.idToken })
      });
      await onAuthenticated();
    } catch (nextError) {
      setMessage(messageForError(nextError));
    } finally {
      setPending(false);
    }
  }

  async function openDemo() {
    setPending(true);
    setMessage(null);
    try {
      await request("/api/demo/session", { method: "POST" });
      await onAuthenticated();
    } catch (nextError) {
      setMessage(messageForError(nextError));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="access-page">
      <section className="access-panel">
        <span className="access-mark">◇</span>
        <p className="eyebrow">LaundryTwin team playground</p>
        <h1>ทดลอง<br />ข้อมูลจริง</h1>
        <p>แดชบอร์ดภายในสำหรับทีม: ดูสถานะระบบ ทดสอบ API และสืบค้นข้อมูล analytics ของสาขาที่ได้รับสิทธิ์</p>
        {message ? <SourceMessage message={message} /> : null}
        <button className="line-button" onClick={signInWithLine} disabled={pending}>เปิดผ่าน LINE</button>
        {demoEnabled ? <button className="demo-button" onClick={openDemo} disabled={pending}>เปิด Demo</button> : null}
      </section>
    </main>
  );
}

function LoadingScreen({ label }: { label: string }) {
  return <div className="loading-state"><span className="loading-orbit" />{label}</div>;
}

function SourceMessage({ message }: { message: string }) {
  return <div className="source-message"><strong>แหล่งข้อมูลยังไม่พร้อม</strong><span>{message}</span></div>;
}

function roleText(grants: Grant[]) {
  return [...new Set(grants.map((grant) => grant.role))].join(" · ") || "No active access grant";
}

function messageForError(error: unknown) {
  if (error instanceof ApiError) return error.message;
  return "ไม่สามารถเชื่อมต่อบริการ LaundryTwin ได้";
}

const ENDPOINTS = [
  { method: "GET", path: "/health", desc: "System health check", auth: false },
  { method: "GET", path: "/api/me", desc: "Current user & grants", auth: true },
  { method: "GET", path: "/api/report/branches", desc: "List accessible branches", auth: true },
  { method: "GET", path: "/api/report/dashboard", desc: "Branch KPI dashboard", auth: true },
  { method: "GET", path: "/api/report/live", desc: "Live machine telemetry", auth: true },
  { method: "GET", path: "/api/report/alerts", desc: "Active alerts", auth: true },
  { method: "GET", path: "/api/report/summary", desc: "Executive summary", auth: true },
  { method: "POST", path: "/api/demo/session", desc: "Create demo session", auth: false },
  { method: "POST", path: "/api/auth/liff/exchange", desc: "Exchange LINE LIFF token", auth: false },
  { method: "GET", path: "/api/v1/analytics/revenue/daily", desc: "Daily revenue analytics", auth: true },
  { method: "GET", path: "/api/v1/analytics/cycles/daily", desc: "Daily cycles analytics", auth: true },
  { method: "GET", path: "/api/v1/analytics/utilization/heatmap", desc: "Utilization heatmap", auth: true },
  { method: "GET", path: "/api/v1/analytics/temperature/curve", desc: "Temperature curve", auth: true }
];

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
