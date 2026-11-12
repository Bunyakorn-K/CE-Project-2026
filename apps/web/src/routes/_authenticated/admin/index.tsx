import { createFileRoute, Link } from "@tanstack/react-router";
import { Card } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useEffect, useState } from "react";
import { apiErrorMessage, apiUrl } from "../../../lib/api/client";
import { buildGrantRequest, canSubmitGrant } from "../../../lib/admin-grant";
import { authAtom } from "../../../lib/atoms/auth";
import { isOwner as hasOwnerGrant } from "../../../lib/access";

export const Route = createFileRoute("/_authenticated/admin/")({
  component: AdminHome
});

type Role = "owner" | "manager" | "technician";
type Branch = { id: string; name: string };
type AccessRequest = { id: string; lineUserId: string; displayName: string; requestedAt: string };
type Grant = { id: string; userId: string; userName: string; userEmail: string; role: Role; branchId: string | null; grantedAt: string };

async function fetchJson<T>(path: string, fallback: string): Promise<T> {
  const response = await fetch(apiUrl(path), { credentials: "include" });
  if (!response.ok) throw new Error(await apiErrorMessage(response, `${fallback} (HTTP ${response.status})`));
  return (await response.json()) as T;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("th-TH", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function roleLabel(role: Role): string {
  if (role === "owner") return "เจ้าของ";
  if (role === "manager") return "ผู้จัดการสาขา";
  return "ช่างเทคนิค";
}

export function AdminHome() {
  const [user] = useAtom(authAtom);
  const isOwner = hasOwnerGrant(user);
  const queryClient = useQueryClient();

  const branchesQuery = useQuery({
    queryKey: ["report", "branches", "admin-access"],
    queryFn: () => fetchJson<{ branches: Branch[] }>("/api/report/branches", "ไม่สามารถโหลดรายชื่อสาขาได้"),
    enabled: isOwner
  });

  const requestsQuery = useQuery({
    queryKey: ["admin", "access-requests"],
    queryFn: () => fetchJson<{ requests: AccessRequest[] }>("/api/admin/access-requests", "ไม่สามารถโหลดคำขอเข้าใช้งานได้"),
    enabled: isOwner
  });

  const grantsQuery = useQuery({
    queryKey: ["admin", "grants"],
    queryFn: () => fetchJson<{ grants: Grant[] }>("/api/admin/grants", "ไม่สามารถโหลดสิทธิ์เข้าใช้งานได้"),
    enabled: isOwner
  });

  const approveMutation = useMutation({
    mutationFn: async ({ id, role, branchId }: { id: string; role: Role; branchId: string | null }) => {
      const response = await fetch(apiUrl(`/api/admin/access-requests/${encodeURIComponent(id)}/approve`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ role, branchId })
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, `อนุมัติคำขอไม่สำเร็จ (HTTP ${response.status})`));
      return (await response.json()) as { ok: boolean };
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "access-requests"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "grants"] })
      ]);
    }
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(apiUrl(`/api/admin/grants/${encodeURIComponent(id)}/revoke`), {
        method: "POST",
        credentials: "include"
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, `เพิกถอนสิทธิ์ไม่สำเร็จ (HTTP ${response.status})`));
      return (await response.json()) as { ok: boolean };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "grants"] });
    }
  });

  const grantMutation = useMutation({
    mutationFn: async ({ email, role, branchId }: { email: string; role: Role; branchId: string | null }) => {
      const response = await fetch(apiUrl("/api/admin/grants"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, role, branchId })
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, `ให้สิทธิ์ไม่สำเร็จ (HTTP ${response.status})`));
      return (await response.json()) as { ok: boolean };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "grants"] });
    }
  });

  if (!isOwner) {
    return (
      <div className="grid gap-6">
        <section className="rounded-xl border border-border bg-surface p-6 shadow-surface grid justify-items-start gap-3 p-6">
          <h1>เข้าถึงไม่ได้</h1>
          <p>หน้าผู้ดูแลใช้ได้เฉพาะบัญชีบทบาทเจ้าของ</p>
          <Link to="/dashboard" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-default px-4 text-sm font-medium text-default-foreground transition-colors hover:bg-default-hover disabled:opacity-50 w-fit">กลับภาพรวม</Link>
        </section>
      </div>
    );
  }

  const branches = branchesQuery.data?.branches ?? [];
  // A grant whose branch is not in the active list shows the raw UUID, which the
  // measurement rule renders as an identifier; a resolved branch name does not.
  const branchScope = (id: string | null): { label: string; isCode: boolean } => {
    if (id === null) return { label: "ทั้งผู้ใช้งาน", isCode: false };
    const branch = branches.find((candidate) => candidate.id === id);
    return { label: branch?.name ?? id, isCode: branch === undefined };
  };
  const branchName = (id: string | null) => branchScope(id).label;

  return (
    <div className="grid gap-6">
      <section className="rounded-xl border border-border bg-surface p-6 shadow-surface">
        <div className="page-header flex items-end justify-between gap-5 max-[639px]:flex-col max-[639px]:items-start">
          <div>
            <h1>การจัดการสิทธิ์</h1>
            <p>อนุมัติคำขอเข้าใช้งาน ตรวจสอบสิทธิ์ที่ใช้งานอยู่ และจัดการการตั้งค่า AI</p>
          </div>
        </div>
      </section>

      {approveMutation.isError && <div className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">อนุมัติคำขอไม่สำเร็จ: {approveMutation.error.message}</div>}
      {approveMutation.isSuccess && <div className="rounded-lg border border-border px-3.5 py-3 text-sm text-muted border-success/30 bg-success-soft text-success-soft-foreground" role="status">อนุมัติคำขอแล้ว</div>}
      {revokeMutation.isError && <div className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">เพิกถอนสิทธิ์ไม่สำเร็จ: {revokeMutation.error.message}</div>}
      {revokeMutation.isSuccess && <div className="rounded-lg border border-border px-3.5 py-3 text-sm text-muted border-success/30 bg-success-soft text-success-soft-foreground" role="status">เพิกถอนสิทธิ์แล้ว</div>}
      {grantMutation.isError && <div className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">ให้สิทธิ์ไม่สำเร็จ: {grantMutation.error.message}</div>}
      {grantMutation.isSuccess && <div className="rounded-lg border border-border px-3.5 py-3 text-sm text-muted border-success/30 bg-success-soft text-success-soft-foreground" role="status">ให้สิทธิ์แล้ว</div>}

      <Card variant="transparent" className="rounded-xl border border-border bg-surface p-6 shadow-surface min-w-0">
        <Card.Content>
          <div className="flex items-baseline justify-between gap-3"><h2>คำขอเข้าใช้งาน</h2><span>รอผู้ดูแลอนุมัติ</span></div>
          {branchesQuery.isError && <div className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">ไม่สามารถโหลดสาขาเพื่อกำหนดขอบเขตได้: {branchesQuery.error.message}</div>}
          {requestsQuery.isLoading && <div className="flex min-h-[60vh] items-center justify-center gap-2.5 text-sm text-muted min-h-[150px]" role="status"><span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />กำลังโหลดคำขอเข้าใช้งาน</div>}
          {requestsQuery.isError && <div className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">ไม่สามารถโหลดคำขอเข้าใช้งานได้: {requestsQuery.error.message}</div>}
          {requestsQuery.data && requestsQuery.data.requests.length === 0 && <div className="rounded-xl border border-dashed border-border bg-surface-secondary p-4 text-sm leading-relaxed text-muted">ไม่มีคำขอเข้าใช้งานที่รออนุมัติ</div>}
          <div className="grid gap-3">
            {requestsQuery.data?.requests.map((request) => (
              <AccessRequestRow
                key={request.id}
                request={request}
                branches={branches}
                pending={approveMutation.isPending && approveMutation.variables?.id === request.id}
                onApprove={(role, branchId) => approveMutation.mutate({ id: request.id, role, branchId })}
              />
            ))}
          </div>
        </Card.Content>
      </Card>

      <Card variant="transparent" className="rounded-xl border border-border bg-surface p-6 shadow-surface min-w-0">
        <Card.Content>
          <div className="flex items-baseline justify-between gap-3"><h2>ให้สิทธิ์ผู้ใช้ที่มีบัญชีแล้ว</h2><span>เพิ่มขอบเขตโดยไม่ต้องรอคำขอ</span></div>
          <p>ใช้เมื่อผู้ใช้เข้าสู่ระบบด้วยตัวเองแล้ว แต่ต้องจำกัดสิทธิ์ให้เหลือเฉพาะสาขาที่ดูแล</p>
          <GrantForm
            branches={branches}
            pending={grantMutation.isPending}
            onGrant={(email, role, branchId) => grantMutation.mutate({ email, role, branchId })}
          />
        </Card.Content>
      </Card>

      <Card variant="transparent" className="rounded-xl border border-border bg-surface p-6 shadow-surface min-w-0">
        <Card.Content>
          <div className="flex items-baseline justify-between gap-3"><h2>สิทธิ์ที่ใช้งานอยู่</h2><span>เพิกถอนจากเซิร์ฟเวอร์ทันที</span></div>
          {grantsQuery.isLoading && <div className="flex min-h-[60vh] items-center justify-center gap-2.5 text-sm text-muted min-h-[150px]" role="status"><span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" />กำลังโหลดสิทธิ์</div>}
          {grantsQuery.isError && <div className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm leading-relaxed text-danger-soft-foreground" role="alert">ไม่สามารถโหลดสิทธิ์ได้: {grantsQuery.error.message}</div>}
          {grantsQuery.data && grantsQuery.data.grants.length === 0 && <div className="rounded-xl border border-dashed border-border bg-surface-secondary p-4 text-sm leading-relaxed text-muted">ไม่มีสิทธิ์ที่ใช้งานอยู่</div>}
          <div className="md:hidden">
            <ul className="admin-list grid gap-3" aria-label="สิทธิ์ที่ใช้งานอยู่">
              {grantsQuery.data?.grants.map((grant) => {
                const scope = branchScope(grant.branchId);
                return (
                  <li key={grant.id} data-grant-card className="grid gap-3.5 rounded-xl border border-border bg-surface-secondary p-3.5">
                    <div className="grid gap-3">
                      <div><span>ผู้ใช้</span><strong className="text-sm font-semibold text-foreground">{grant.userName}</strong><small className="break-all font-mono text-xs text-muted">{grant.userEmail}</small></div>
                      <div><span>บทบาท</span><strong className="text-sm font-semibold text-foreground">{roleLabel(grant.role)}</strong></div>
                      <div><span>ขอบเขต</span><strong className={scope.isCode ? "font-mono text-xs text-muted" : "text-sm font-semibold text-foreground"}>{scope.label}</strong></div>
                      <div><span>ให้สิทธิ์เมื่อ</span><strong className="font-mono text-xs text-muted">{formatDate(grant.grantedAt)}</strong></div>
                    </div>
                    <button type="button" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-danger-soft px-3 text-sm font-medium text-danger-soft-foreground transition-colors hover:bg-danger-soft-hover disabled:opacity-50 w-fit" disabled={revokeMutation.isPending && revokeMutation.variables === grant.id} onClick={() => revokeMutation.mutate(grant.id)}>{revokeMutation.isPending && revokeMutation.variables === grant.id ? "กำลังเพิกถอน…" : "เพิกถอน"}</button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="w-full overflow-x-auto rounded-lg border border-border hidden md:block">
            <table className="admin-table w-full min-w-[620px] border-collapse text-sm">
              <thead><tr><th scope="col">ผู้ใช้</th><th scope="col">บทบาท</th><th scope="col">ขอบเขต</th><th scope="col">ให้สิทธิ์เมื่อ</th><th scope="col">การจัดการ</th></tr></thead>
              <tbody>
                {grantsQuery.data?.grants.map((grant) => (
                  <tr key={grant.id}>
                    <td><strong>{grant.userName}</strong><span className="mt-1 block text-[11px] text-muted">{grant.userEmail}</span></td>
                    <td>{roleLabel(grant.role)}</td>
                    <td>{branchName(grant.branchId)}</td>
                    <td>{formatDate(grant.grantedAt)}</td>
                    <td><button type="button" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-danger-soft px-3 text-sm font-medium text-danger-soft-foreground transition-colors hover:bg-danger-soft-hover disabled:opacity-50" disabled={revokeMutation.isPending && revokeMutation.variables === grant.id} onClick={() => revokeMutation.mutate(grant.id)}>{revokeMutation.isPending && revokeMutation.variables === grant.id ? "กำลังเพิกถอน…" : "เพิกถอน"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card.Content>
      </Card>

      <Card variant="transparent" className="rounded-xl border border-border bg-surface p-6 shadow-surface min-w-0">
        <Card.Content>
          <div className="flex items-baseline justify-between gap-3"><h2>AI Console</h2><span>สำหรับเจ้าของเท่านั้น</span></div>
          <p>ตั้งค่า gateway โมเดล และทดสอบผู้ช่วยแบบข้อความผ่านเซิร์ฟเวอร์</p>
          <Link to="/admin/ai" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-default px-4 text-sm font-medium text-default-foreground transition-colors hover:bg-default-hover disabled:opacity-50 mt-4 w-fit">เปิด AI Settings</Link>
        </Card.Content>
      </Card>

      <Card variant="transparent" className="rounded-xl border border-border bg-surface p-6 shadow-surface min-w-0">
        <Card.Content>
          <div className="flex items-baseline justify-between gap-3"><h2>การแจ้งเตือน LINE</h2><span>สำหรับเจ้าของเท่านั้น</span></div>
          <p>กำหนดความถี่ในการแจ้งซ้ำและเพดานข้อความต่อเดือน พร้อมดูโควตาที่ใช้ไปแล้ว</p>
          <Link to="/admin/alerts" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-default px-4 text-sm font-medium text-default-foreground transition-colors hover:bg-default-hover disabled:opacity-50 mt-4 w-fit">เปิดการตั้งค่าการแจ้งเตือน</Link>
        </Card.Content>
      </Card>

      <Card variant="transparent" className="rounded-xl border border-border bg-surface p-6 shadow-surface min-w-0">
        <Card.Content>
          <div className="flex items-baseline justify-between gap-3"><h2>เมนู LINE</h2><span>สำหรับเจ้าของเท่านั้น</span></div>
          <p>แผงเมนูในแชท LINE แยกตามบทบาท และปุ่มซิงก์เมนูกับ LINE</p>
          <Link to="/admin/line" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-default px-4 text-sm font-medium text-default-foreground transition-colors hover:bg-default-hover disabled:opacity-50 mt-4 w-fit">เปิดเมนู LINE</Link>
        </Card.Content>
      </Card>
    </div>
  );
}

/**
 * Grant a role to an account that already exists.
 *
 * Approving a pending request was the only path to a grant, so narrowing someone
 * who had signed in on their own was impossible. The address is typed rather
 * than picked from a list because the only accounts this can name are ones that
 * have already signed in, and an owner knows an employee's address; offering a
 * dropdown of everyone would read as a directory the product does not have.
 */
function GrantForm({ branches, pending, onGrant }: { branches: Branch[]; pending: boolean; onGrant: (email: string, role: Role, branchId: string | null) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("manager");
  const [branchId, setBranchId] = useState("");
  useEffect(() => {
    if (!branchId && branches[0]) setBranchId(branches[0].id);
  }, [branchId, branches]);

  return (
    <form
      className="grid gap-3.5 rounded-xl border border-border bg-surface-secondary p-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        const request = buildGrantRequest({ email, role, branchId });
        if (!request.ok) return;
        onGrant(request.body.email, request.body.role, request.body.branchId);
        setEmail("");
      }}
    >
      <div className="grid items-end gap-2.5 md:grid-cols-[minmax(170px,1fr)_minmax(170px,1fr)_auto] md:grid-cols-[minmax(220px,1.4fr)_minmax(150px,1fr)_minmax(150px,1fr)_auto]">
        <label>
          <span>อีเมลผู้ใช้</span>
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="user@example.com" required />
        </label>
        <label>
          <span>บทบาท</span>
          <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
            <option value="owner">เจ้าของ · ทั้งผู้ใช้งาน</option>
            <option value="manager">ผู้จัดการสาขา</option>
            <option value="technician">ช่างเทคนิค</option>
          </select>
        </label>
        <label>
          <span>สาขา</span>
          <select value={role === "owner" ? "" : branchId} disabled={role === "owner" || branches.length === 0} onChange={(event) => setBranchId(event.target.value)} required={role !== "owner"}>
            {branches.length === 0 && <option value="">ไม่มีสาขาให้เลือก</option>}
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        </label>
        <button type="submit" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50" disabled={pending || !canSubmitGrant({ email, role, branchId })}>{pending ? "กำลังให้สิทธิ์…" : "ให้สิทธิ์"}</button>
      </div>
    </form>
  );
}

function AccessRequestRow({ request, branches, pending, onApprove }: { request: AccessRequest; branches: Branch[]; pending: boolean; onApprove: (role: Role, branchId: string | null) => void }) {  const [role, setRole] = useState<Role>("manager");
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  useEffect(() => {
    if (!branchId && branches[0]) setBranchId(branches[0].id);
  }, [branchId, branches]);
  return (
    <form
      className="grid gap-3.5 rounded-xl border border-border bg-surface-secondary p-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        onApprove(role, role === "owner" ? null : branchId);
      }}
    >
      <div className="flex items-start justify-between gap-4 max-[639px]:flex-col">
        <div><span>ผู้ขอใช้งาน</span><strong>{request.displayName}</strong><small className="font-mono text-[11px] text-muted">LINE: {request.lineUserId}</small></div>
        <div><span>ส่งคำขอเมื่อ</span><strong>{formatDate(request.requestedAt)}</strong></div>
      </div>
      <div className="grid items-end gap-2.5 md:grid-cols-[minmax(170px,1fr)_minmax(170px,1fr)_auto]">
        <label>
          <span>บทบาท</span>
          <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
            <option value="owner">เจ้าของ · ทั้งผู้ใช้งาน</option>
            <option value="manager">ผู้จัดการสาขา</option>
            <option value="technician">ช่างเทคนิค</option>
          </select>
        </label>
        <label>
          <span>สาขา</span>
          <select value={role === "owner" ? "" : branchId} disabled={role === "owner" || branches.length === 0} onChange={(event) => setBranchId(event.target.value)} required={role !== "owner"}>
            {branches.length === 0 && <option value="">ไม่มีสาขาให้เลือก</option>}
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        </label>
        <button type="submit" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50" disabled={pending || (role !== "owner" && !branchId)}>{pending ? "กำลังอนุมัติ…" : "อนุมัติคำขอ"}</button>
      </div>
    </form>
  );
}
