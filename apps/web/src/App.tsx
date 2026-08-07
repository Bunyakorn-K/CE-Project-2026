import { Button, Card, Chip } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import { apiBaseUrl, authClient } from "./auth-client";
import { summarizeMachineActivity } from "./dashboard-metrics";
import { connectLiff } from "./liff";

type Role = "owner" | "manager" | "technician";
type Grant = { id: string; role: Role; branchId: string | null };
type Branch = { id: string; code: string; name: string; timezone: string; status: string };
type Coverage = { available: boolean; reason?: string };

type Dashboard = {
  fetchedAt: string;
  branches: Array<{
    branch: Branch;
    kpi: { revenueSatang: number | null; cycles: number; machineCount: number; totalCycleMinutes: number; utilization: number | null };
  }>;
  totals: { revenueSatang: number | null; cycles: number; machineCount: number };
};

type LiveMachine = {
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
    temperatureC: number | null;
    doorStatus: string | null;
    coinbox: string | null;
    paidSatang: number | null;
  };
  coverage: Record<string, Coverage>;
};

type AlertItem = {
  id: string;
  branchId: string | null;
  machineId: string | null;
  severity: string;
  title: string;
  detail: string | null;
  detectedAt: string;
  acknowledgedLocally: boolean;
  coverage: Record<string, Coverage>;
};

type Me = { user: { id: string; name: string; email: string }; source: "better-auth" | "liff" | "demo"; grants: Grant[] };
type AccessRequest = { id: string; lineUserId: string; displayName: string; requestedAt: string };
type ActiveGrant = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  role: Role;
  branchId: string | null;
  grantedAt: string;
};

type DashboardState = {
  dashboard: Dashboard;
  machines: LiveMachine[];
  alerts: AlertItem[];
  summary: string;
};

class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { credentials: "include", ...init });
  const payload = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | T | null;
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new ApiError(error?.message ?? "The request could not be completed", response.status, error?.code);
  }
  return payload as T;
}

function reportQuery(branchId: string) {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return new URLSearchParams({ branchId, from: start.toISOString(), to: end.toISOString() }).toString();
}

function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [demoMode, setDemoMode] = useState(false);

  async function loadAccess() {
    setError(null);
    try {
      const nextMe = await request<Me>("/api/me");
      setMe(nextMe);
      try {
        const branchResponse = await request<{ branches: Branch[] }>("/api/report/branches");
        setBranches(branchResponse.branches);
        setSelectedBranchId((current) => current ?? branchResponse.branches[0]?.id ?? null);
      } catch (nextError) {
        setBranches([]);
        setSelectedBranchId(null);
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

  async function loadReport(branchId: string) {
    setIsRefreshing(true);
    setError(null);
    const query = reportQuery(branchId);
    try {
      const [dashboardResponse, liveResponse, alertResponse, summaryResponse] = await Promise.all([
        request<{ dashboard: Dashboard }>(`/api/report/dashboard?${query}`),
        request<{ live: { machines: LiveMachine[] } }>(`/api/report/live?branchId=${encodeURIComponent(branchId)}`),
        request<{ alerts: { alerts: AlertItem[] } }>(`/api/report/alerts?${query}`),
        request<{ summary: string }>(`/api/report/summary?${query}`)
      ]);
      setState({
        dashboard: dashboardResponse.dashboard,
        machines: liveResponse.live.machines,
        alerts: alertResponse.alerts.alerts,
        summary: summaryResponse.summary
      });
    } catch (nextError) {
      setError(messageForError(nextError));
    } finally {
      setIsRefreshing(false);
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

  useEffect(() => {
    if (me && selectedBranchId) void loadReport(selectedBranchId);
  }, [me, selectedBranchId]);

  if (me === undefined) {
    return <LoadingScreen label="กำลังตรวจสอบสิทธิ์การเข้าถึง" />;
  }

  if (me === null) {
    return <AccessScreen demoEnabled={demoMode} error={error} onAuthenticated={loadAccess} />;
  }

  const isAdminPath = window.location.pathname === "/mange";
  const selectedBranch = branches.find((branch) => branch.id === selectedBranchId) ?? null;
  if (isAdminPath) {
    return (
      <main id="top">
        <Header
          branch={null}
          user={me}
          refreshedAt={null}
          isRefreshing={isRefreshing}
          onRefresh={() => void loadAccess()}
          onSignOut={async () => {
            await Promise.allSettled([authClient.signOut(), request<{ ok: boolean }>("/api/auth/liff/logout", { method: "POST" })]);
            setMe(null);
          }}
        />
        <div className="page-shell"><AdminScreen branches={branches} error={error} me={me} /></div>
      </main>
    );
  }
  return (
    <main id="top">
      <Header
        branch={selectedBranch}
        user={me}
        refreshedAt={state?.dashboard.fetchedAt ?? null}
        isRefreshing={isRefreshing}
        onRefresh={() => selectedBranchId && void loadReport(selectedBranchId)}
        onSignOut={async () => {
          await Promise.allSettled([
            authClient.signOut(),
            request<{ ok: boolean }>("/api/auth/liff/logout", { method: "POST" })
          ]);
          setMe(null);
          setState(null);
        }}
      />
      <div className="page-shell">
        {branches.length > 1 ? (
          <nav className="branch-rail" aria-label="เลือกสาขา">
            {branches.map((branch) => (
              <button
                className={branch.id === selectedBranchId ? "branch-choice is-selected" : "branch-choice"}
                key={branch.id}
                onClick={() => setSelectedBranchId(branch.id)}
              >
                <span>{branch.code}</span>
                {branch.name}
              </button>
            ))}
          </nav>
        ) : null}

        {error ? <SourceMessage message={error} /> : null}
        {!selectedBranch ? <SourceMessage message="ยังไม่มีสาขาที่บัญชีนี้ได้รับสิทธิ์เข้าถึง" /> : null}
        {selectedBranch && !state && !error ? <LoadingScreen label="กำลังรับรายงานจาก IRIS" compact /> : null}
        {state && selectedBranch ? (
          <DashboardView
            branch={selectedBranch}
            state={state}
            maySeeRevenue={me.grants.some((grant) => grant.role === "owner" || grant.role === "manager")}
            onAcknowledge={async (alert) => {
              await request(`/api/alerts/${encodeURIComponent(alert.id)}/acknowledge`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ branchId: selectedBranch.id })
              });
              setState((current) =>
                current
                  ? { ...current, alerts: current.alerts.map((item) => (item.id === alert.id ? { ...item, acknowledgedLocally: true } : item)) }
                  : current
              );
            }}
          />
        ) : null}
      </div>
    </main>
  );
}

function Header({
  branch,
  user,
  refreshedAt,
  isRefreshing,
  onRefresh,
  onSignOut
}: {
  branch: Branch | null;
  user: Me;
  refreshedAt: string | null;
  isRefreshing: boolean;
  onRefresh: () => void;
  onSignOut: () => void;
}) {
  const [accountOpen, setAccountOpen] = useState(false);
  return (
    <>
      <header className="topbar">
        <div className="brand" aria-label="LaundryTwin reporting">
          <span className="brand-mark" aria-hidden="true">◌</span>
          <span>
            <strong>LaundryTwin</strong>
            <small>{branch?.name ?? "Operational reporting"}</small>
          </span>
        </div>
        <div className="topbar-actions">
          <button className="icon-button" onClick={onRefresh} aria-label="รีเฟรชรายงาน" disabled={isRefreshing}>
            {isRefreshing ? "···" : "↻"}
          </button>
          <button className="account-button" onClick={() => setAccountOpen(true)}>{user.user.name}</button>
        </div>
      </header>
      <div className="source-strip">
        <span className="live-dot" />
        <span>{user.source === "demo" ? "DEMO MODE · simulated reporting data" : refreshedAt ? `IRIS report · ${formatTime(refreshedAt)}` : "กำลังรอข้อมูลจาก IRIS"}</span>
      </div>
      {accountOpen ? (
        <aside className="account-panel" aria-label="บัญชีผู้ใช้">
          <p className="eyebrow">Signed in through {user.source}</p>
          <h2>{user.user.name}</h2>
          <p>{roleText(user.grants)}</p>
          <div className="account-actions">
            {user.grants.some((grant) => grant.role === "owner") ? <a className="admin-link" href="/mange">จัดการสิทธิ์</a> : null}
            <Button variant="secondary" onPress={() => setAccountOpen(false)}>ปิด</Button>
            <Button variant="primary" onPress={onSignOut}>ออกจากระบบ</Button>
          </div>
        </aside>
      ) : null}
    </>
  );
}

function DashboardView({
  branch,
  state,
  maySeeRevenue,
  onAcknowledge
}: {
  branch: Branch;
  state: DashboardState;
  maySeeRevenue: boolean;
  onAcknowledge: (alert: AlertItem) => Promise<void>;
}) {
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);
  const activity = summarizeMachineActivity(state.machines);
  const runningMachines = activity.running;
  const readyMachines = activity.ready;
  const sourceUnavailable = activity.unavailable;
  const openAlerts = state.alerts.filter((alert) => !alert.acknowledgedLocally);

  return (
    <>
      <section className="pulse-panel" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">{branch.code} · {branch.timezone}</p>
          <h1 id="page-title">สถานะสาขา<br />ที่ตรวจสอบได้</h1>
        </div>
        <div className="pulse-scale" aria-label="ความสดของข้อมูลเครื่อง">
          <span className="pulse-label">Floor pulse</span>
          <div className="pulse-track">
            {state.machines.map((machine) => <span className={`pulse-node ${machine.freshness}`} key={machine.id} />)}
          </div>
          <span>{sourceUnavailable > 0 ? `ไม่พร้อม ${sourceUnavailable} เครื่อง` : "ข้อมูลสดพร้อม"}</span>
        </div>
      </section>

      <section className="summary-grid" aria-label="สรุปประจำช่วงเวลา">
        <Metric label="กำลังทำงาน" value={runningMachines} detail="จากสถานะสด" />
        <Metric label="พร้อมใช้" value={readyMachines} detail="จากสถานะสด" />
        <Metric label="ต้องติดตาม" value={openAlerts.length} detail="จาก alert source" tone={openAlerts.length > 0 ? "warning" : undefined} />
        <Metric
          label="ยอดชำระสำเร็จ"
          value={maySeeRevenue && state.dashboard.totals.revenueSatang !== null ? formatBaht(state.dashboard.totals.revenueSatang) : "—"}
          detail={maySeeRevenue ? "paid transactions" : "ไม่มีสิทธิ์ดูรายได้"}
        />
      </section>

      <section className="summary-note" aria-label="สรุปสำหรับผู้เกี่ยวข้อง">
        <p className="eyebrow">Executive brief</p>
        <p>{state.summary}</p>
        <small>Generated deterministically from IRIS reporting data.</small>
      </section>

      <section className="section-block" aria-labelledby="alerts-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Attention queue</p>
            <h2 id="alerts-title">รายการที่ควรดู</h2>
          </div>
          <span>{openAlerts.length} open</span>
        </div>
        {state.alerts.length === 0 ? <EmptyState text="ไม่มี alert ในช่วงเวลารายงานนี้" /> : null}
        <div className="alert-list">
          {state.alerts.map((alert) => (
            <Card className={`alert-card severity-${alert.severity}`} key={alert.id} variant="secondary">
              <Card.Content>
                <div className="alert-card-topline">
                  <Chip color={severityColor(alert.severity)} variant="soft" size="sm">{severityLabel(alert.severity)}</Chip>
                  <time>{formatTime(alert.detectedAt)}</time>
                </div>
                <h3>{alert.title}</h3>
                {alert.detail ? <p>{alert.detail}</p> : null}
                {!alert.coverage.ruleVersion?.available ? <small>รุ่นของกฎยังไม่มีใน IRIS alert record</small> : null}
                {alert.acknowledgedLocally ? <span className="acknowledged">รับทราบแล้วใน LaundryTwin</span> : (
                  <Button
                    size="sm"
                    variant="secondary"
                    isPending={acknowledgingId === alert.id}
                    onPress={async () => {
                      setAcknowledgingId(alert.id);
                      try {
                        await onAcknowledge(alert);
                      } finally {
                        setAcknowledgingId(null);
                      }
                    }}
                  >
                    รับทราบ
                  </Button>
                )}
              </Card.Content>
            </Card>
          ))}
        </div>
      </section>

      <section className="section-block" aria-labelledby="machines-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Machine telemetry</p>
            <h2 id="machines-title">สถานะเครื่อง</h2>
          </div>
          <span>{state.machines.length} units</span>
        </div>
        {state.machines.length === 0 ? <EmptyState text="IRIS ยังไม่มีเครื่องที่ map กับสาขานี้" /> : null}
        <div className="machine-stack">
          {state.machines.map((machine) => <MachineCard machine={machine} key={machine.id} />)}
        </div>
      </section>
    </>
  );
}

function MachineCard({ machine }: { machine: LiveMachine }) {
  const telemetry = machine.telemetry;
  const coverageReason = Object.values(machine.coverage).find((item) => !item.available)?.reason;
  return (
    <Card className={`machine-card freshness-${machine.freshness}`} variant="secondary">
      <Card.Content>
        <div className="machine-card-topline">
          <div>
            <p className="machine-code">{machine.code}</p>
            <h3>{machine.kind === "dryer" ? "Dryer" : "Washer"}</h3>
          </div>
          <Chip color={freshnessColor(machine.freshness)} variant="soft" size="sm">{freshnessLabel(machine.freshness)}</Chip>
        </div>
        <div className="machine-state-row">
          <span>สถานะที่รายงาน</span>
          <strong>{machine.state ?? "ไม่พร้อม"}</strong>
        </div>
        <div className="machine-facts">
          <Fact label="เวลาเหลือ" value={formatDuration(machine.remainingSeconds)} />
          <Fact label="อุณหภูมิ" value={telemetry?.temperatureC === null || telemetry?.temperatureC === undefined ? "ไม่พร้อม" : `${telemetry.temperatureC}°C`} />
          <Fact label="ประตู" value={telemetry?.doorStatus ?? "ไม่พร้อม"} />
          <Fact label="Coinbox" value={telemetry?.coinbox ?? "ไม่พร้อม"} />
        </div>
        {machine.freshness === "unavailable" || machine.freshness === "stale" ? (
          <p className="machine-source-note">{machine.reason ?? coverageReason ?? "แหล่ง telemetry ยังไม่พร้อม"}</p>
        ) : null}
      </Card.Content>
    </Card>
  );
}

function AdminScreen({ branches, error, me }: { branches: Branch[]; error: string | null; me: Me }) {
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [grants, setGrants] = useState<ActiveGrant[]>([]);
  const [message, setMessage] = useState(error);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, { role: Role; branchId: string }>>({});
  const isOwner = me.grants.some((grant) => grant.role === "owner");

  async function loadAdmin() {
    if (!isOwner) return;
    setIsLoading(true);
    try {
      const [requestResponse, grantResponse] = await Promise.all([
        request<{ requests: AccessRequest[] }>("/api/admin/access-requests"),
        request<{ grants: ActiveGrant[] }>("/api/admin/grants")
      ]);
      setRequests(requestResponse.requests);
      setGrants(grantResponse.grants);
      setMessage(null);
    } catch (nextError) {
      setMessage(messageForError(nextError));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadAdmin();
  }, []);

  if (!isOwner) {
    return <SourceMessage message="หน้านี้ใช้ได้เฉพาะ LaundryTwin owner" />;
  }

  return (
    <>
      <section className="admin-hero">
        <p className="eyebrow">Access control</p>
        <h1>สิทธิ์การดูรายงาน</h1>
        <p>การเปลี่ยนแปลงด้านล่างมีผลเฉพาะบัญชี LaundryTwin ไม่แก้สิทธิ์หรือข้อมูลใน IRIS</p>
      </section>
      {message ? <SourceMessage message={message} /> : null}
      {isLoading ? <LoadingScreen compact label="กำลังอ่านสิทธิ์การเข้าถึง" /> : null}
      {!isLoading ? (
        <>
          <section className="section-block" aria-labelledby="requests-title">
            <div className="section-heading"><div><p className="eyebrow">LINE requests</p><h2 id="requests-title">คำขอรออนุมัติ</h2></div><span>{requests.length} pending</span></div>
            {requests.length === 0 ? <EmptyState text="ไม่มี LINE access request ที่รออนุมัติ" /> : null}
            <div className="admin-list">
              {requests.map((accessRequest) => {
                const choice = choices[accessRequest.id] ?? { role: "technician" as Role, branchId: branches[0]?.id ?? "" };
                return (
                  <Card className="admin-card" key={accessRequest.id} variant="secondary">
                    <Card.Content>
                      <div><h3>{accessRequest.displayName}</h3><p>{formatDateTime(accessRequest.requestedAt)}</p></div>
                      <div className="grant-form">
                        <label>Role<select value={choice.role} onChange={(event) => setChoices((current) => ({ ...current, [accessRequest.id]: { ...choice, role: event.target.value as Role } }))}>
                          <option value="technician">Technician</option><option value="manager">Manager</option><option value="owner">Owner</option>
                        </select></label>
                        {choice.role !== "owner" ? <label>สาขา<select value={choice.branchId} onChange={(event) => setChoices((current) => ({ ...current, [accessRequest.id]: { ...choice, branchId: event.target.value } }))}>
                          <option value="">เลือกสาขา</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.code} · {branch.name}</option>)}
                        </select></label> : <p className="owner-scope">Owner เห็นทุกสาขาใน tenant ที่ตั้งค่าไว้</p>}
                        <Button
                          size="sm"
                          variant="primary"
                          isDisabled={choice.role !== "owner" && !choice.branchId}
                          isPending={pendingId === accessRequest.id}
                          onPress={async () => {
                            setPendingId(accessRequest.id);
                            try {
                              await request(`/api/admin/access-requests/${encodeURIComponent(accessRequest.id)}/approve`, {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({ role: choice.role, branchId: choice.role === "owner" ? null : choice.branchId })
                              });
                              await loadAdmin();
                            } catch (nextError) {
                              setMessage(messageForError(nextError));
                            } finally {
                              setPendingId(null);
                            }
                          }}
                        >อนุมัติ</Button>
                      </div>
                    </Card.Content>
                  </Card>
                );
              })}
            </div>
          </section>

          <section className="section-block" aria-labelledby="grants-title">
            <div className="section-heading"><div><p className="eyebrow">Active access</p><h2 id="grants-title">สิทธิ์ที่ใช้งานอยู่</h2></div><span>{grants.length} grants</span></div>
            <div className="admin-list">
              {grants.map((grant) => (
                <Card className="admin-card" key={grant.id} variant="secondary"><Card.Content>
                  <div><h3>{grant.userName}</h3><p>{grant.role} · {branchName(branches, grant.branchId)}</p><small>{grant.userEmail}</small></div>
                  <Button size="sm" variant="secondary" isPending={pendingId === grant.id} onPress={async () => {
                    setPendingId(grant.id);
                    try {
                      await request(`/api/admin/grants/${encodeURIComponent(grant.id)}/revoke`, { method: "POST" });
                      await loadAdmin();
                    } catch (nextError) {
                      setMessage(messageForError(nextError));
                    } finally {
                      setPendingId(null);
                    }
                  }}>เพิกถอน</Button>
                </Card.Content></Card>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}

function AccessScreen({
  demoEnabled,
  error,
  onAuthenticated
}: {
  demoEnabled: boolean;
  error: string | null;
  onAuthenticated: () => Promise<void>;
}) {
  const liffId = import.meta.env.VITE_LIFF_ID as string | undefined;
  const [message, setMessage] = useState(error);
  const [pending, setPending] = useState(false);
  const [showLocal, setShowLocal] = useState(false);
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

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

  async function submitLocal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const result = mode === "sign-in"
      ? await authClient.signIn.email({ email, password })
      : await authClient.signUp.email({ name, email, password });
    setPending(false);
    if (result.error) {
      setMessage(result.error.message ?? "เข้าสู่ระบบไม่สำเร็จ");
      return;
    }
    await onAuthenticated();
  }

  return (
    <main className="access-page">
      <section className="access-panel">
        <span className="access-mark">◌</span>
        <p className="eyebrow">LaundryTwin reporting</p>
        <h1>รายงานที่<br />อ้างอิงข้อมูลจริง</h1>
        <p>ดูสถานะเครื่อง, telemetry และ alert ของสาขาที่คุณได้รับสิทธิ์เท่านั้น</p>
        {message ? <SourceMessage message={message} /> : null}
        <Button className="line-button" variant="primary" onPress={signInWithLine} isPending={pending}>เปิดผ่าน LINE</Button>
        {demoEnabled ? <Button className="demo-button" variant="secondary" onPress={openDemo} isPending={pending}>เปิด Demo</Button> : null}
        <button className="local-toggle" onClick={() => setShowLocal((current) => !current)}>ผู้ดูแลระบบใช้บัญชี local</button>
        {showLocal ? (
          <form className="local-form" onSubmit={submitLocal}>
            {mode === "sign-up" ? <input placeholder="ชื่อ" value={name} onChange={(event) => setName(event.target.value)} required /> : null}
            <input type="email" placeholder="อีเมล" value={email} onChange={(event) => setEmail(event.target.value)} required />
            <input type="password" placeholder="รหัสผ่าน" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required />
            <Button type="submit" variant="secondary" isPending={pending}>{mode === "sign-in" ? "เข้าสู่ระบบ" : "สร้างบัญชี"}</Button>
            <button type="button" className="local-toggle" onClick={() => setMode((current) => current === "sign-in" ? "sign-up" : "sign-in")}>
              {mode === "sign-in" ? "สร้างบัญชี local สำหรับ owner" : "มีบัญชีอยู่แล้ว"}
            </button>
          </form>
        ) : null}
      </section>
    </main>
  );
}

function Metric({ label, value, detail, tone }: { label: string; value: string | number; detail: string; tone?: "warning" }) {
  return (
    <Card className={`metric-card ${tone ? `tone-${tone}` : ""}`} variant="secondary">
      <Card.Content>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </Card.Content>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

function LoadingScreen({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={compact ? "loading-state compact" : "loading-state"}><span className="loading-orbit" />{label}</div>;
}

function SourceMessage({ message }: { message: string }) {
  return <div className="source-message"><strong>แหล่งข้อมูลยังไม่พร้อม</strong><span>{message}</span></div>;
}

function formatDuration(value: number | null) {
  if (value === null) return "ไม่พร้อม";
  const minutes = Math.ceil(value / 60);
  return `${minutes} นาที`;
}

function formatBaht(satang: number) {
  return `฿${new Intl.NumberFormat("th-TH", { maximumFractionDigits: 0 }).format(satang / 100)}`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function branchName(branches: Branch[], branchId: string | null) {
  if (!branchId) return "ทุกสาขา";
  const branch = branches.find((item) => item.id === branchId);
  return branch ? `${branch.code} · ${branch.name}` : "สาขาที่ยังไม่โหลด";
}

function messageForError(error: unknown) {
  if (error instanceof ApiError) return error.message;
  return "ไม่สามารถเชื่อมต่อบริการ LaundryTwin ได้";
}

function freshnessColor(value: LiveMachine["freshness"]): "success" | "warning" | "danger" {
  return value === "fresh" ? "success" : value === "stale" ? "warning" : "danger";
}

function freshnessLabel(value: LiveMachine["freshness"]) {
  return value === "fresh" ? "สด" : value === "stale" ? "ล่าช้า" : "ไม่พร้อม";
}

function severityColor(value: string): "accent" | "warning" | "danger" {
  return value === "critical" ? "danger" : value === "warning" ? "warning" : "accent";
}

function severityLabel(value: string) {
  return value === "critical" ? "เร่งด่วน" : value === "warning" ? "ติดตาม" : "ข้อมูล";
}

function roleText(grants: Grant[]) {
  return [...new Set(grants.map((grant) => grant.role))].join(" · ") || "No active access grant";
}

export default App;
