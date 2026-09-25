import { createFileRoute, Link } from "@tanstack/react-router";
import { Card } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useEffect, useState } from "react";
import { apiErrorMessage, apiUrl } from "../../../lib/api/client";
import { authAtom } from "../../../lib/atoms/auth";

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
  const isOwner = user?.grants.some((grant) => grant.role === "owner") ?? false;
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

  if (!isOwner) {
    return (
      <div className="page-content">
        <section className="surface-card restricted-state">
          <h1>เข้าถึงไม่ได้</h1>
          <p>หน้าผู้ดูแลใช้ได้เฉพาะบัญชีบทบาทเจ้าของ</p>
          <Link to="/dashboard" className="secondary-button w-fit">กลับภาพรวม</Link>
        </section>
      </div>
    );
  }

  const branches = branchesQuery.data?.branches ?? [];
  const branchName = (id: string | null) => id === null ? "ทั้งผู้ใช้งาน" : branches.find((branch) => branch.id === id)?.name ?? id;

  return (
    <div className="page-content">
      <section className="surface-card surface-card--dark">
        <h1>การจัดการสิทธิ์</h1>
        <p>อนุมัติคำขอเข้าใช้งาน ตรวจสอบสิทธิ์ที่ใช้งานอยู่ และจัดการการตั้งค่า AI</p>
      </section>

      {approveMutation.isError && <div className="error-message" role="alert">อนุมัติคำขอไม่สำเร็จ: {approveMutation.error.message}</div>}
      {approveMutation.isSuccess && <div className="feedback-message feedback-message--success" role="status">อนุมัติคำขอแล้ว</div>}
      {revokeMutation.isError && <div className="error-message" role="alert">เพิกถอนสิทธิ์ไม่สำเร็จ: {revokeMutation.error.message}</div>}
      {revokeMutation.isSuccess && <div className="feedback-message feedback-message--success" role="status">เพิกถอนสิทธิ์แล้ว</div>}

      <Card variant="transparent" className="surface-card admin-section">
        <Card.Content>
          <div className="section-heading"><h2>คำขอเข้าใช้งาน</h2><span>รอผู้ดูแลอนุมัติ</span></div>
          {branchesQuery.isError && <div className="error-message" role="alert">ไม่สามารถโหลดสาขาเพื่อกำหนดขอบเขตได้: {branchesQuery.error.message}</div>}
          {requestsQuery.isLoading && <div className="loading-state compact" role="status"><span className="loading-orbit" />กำลังโหลดคำขอเข้าใช้งาน</div>}
          {requestsQuery.isError && <div className="error-message" role="alert">ไม่สามารถโหลดคำขอเข้าใช้งานได้: {requestsQuery.error.message}</div>}
          {requestsQuery.data && requestsQuery.data.requests.length === 0 && <div className="state-message">ไม่มีคำขอเข้าใช้งานที่รออนุมัติ</div>}
          <div className="admin-list">
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

      <Card variant="transparent" className="surface-card admin-section">
        <Card.Content>
          <div className="section-heading"><h2>สิทธิ์ที่ใช้งานอยู่</h2><span>เพิกถอนจากเซิร์ฟเวอร์ทันที</span></div>
          {grantsQuery.isLoading && <div className="loading-state compact" role="status"><span className="loading-orbit" />กำลังโหลดสิทธิ์</div>}
          {grantsQuery.isError && <div className="error-message" role="alert">ไม่สามารถโหลดสิทธิ์ได้: {grantsQuery.error.message}</div>}
          {grantsQuery.data && grantsQuery.data.grants.length === 0 && <div className="state-message">ไม่มีสิทธิ์ที่ใช้งานอยู่</div>}
          <div className="table-scroll">
            <table className="data-table admin-table">
              <thead><tr><th scope="col">ผู้ใช้</th><th scope="col">บทบาท</th><th scope="col">ขอบเขต</th><th scope="col">ให้สิทธิ์เมื่อ</th><th scope="col">การจัดการ</th></tr></thead>
              <tbody>
                {grantsQuery.data?.grants.map((grant) => (
                  <tr key={grant.id}>
                    <td><strong>{grant.userName}</strong><span className="table-subtext">{grant.userEmail}</span></td>
                    <td>{roleLabel(grant.role)}</td>
                    <td>{branchName(grant.branchId)}</td>
                    <td>{formatDate(grant.grantedAt)}</td>
                    <td><button type="button" className="danger-button" disabled={revokeMutation.isPending && revokeMutation.variables === grant.id} onClick={() => revokeMutation.mutate(grant.id)}>{revokeMutation.isPending && revokeMutation.variables === grant.id ? "กำลังเพิกถอน…" : "เพิกถอน"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card.Content>
      </Card>

      <Card variant="transparent" className="surface-card admin-section">
        <Card.Content>
          <div className="section-heading"><h2>AI Console</h2><span>สำหรับเจ้าของเท่านั้น</span></div>
          <p>ตั้งค่า gateway โมเดล และทดสอบผู้ช่วยแบบข้อความผ่านเซิร์ฟเวอร์</p>
          <Link to="/admin/ai" className="secondary-button mt-4 w-fit">เปิด AI Settings</Link>
        </Card.Content>
      </Card>
    </div>
  );
}

function AccessRequestRow({ request, branches, pending, onApprove }: { request: AccessRequest; branches: Branch[]; pending: boolean; onApprove: (role: Role, branchId: string | null) => void }) {
  const [role, setRole] = useState<Role>("manager");
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  useEffect(() => {
    if (!branchId && branches[0]) setBranchId(branches[0].id);
  }, [branchId, branches]);
  return (
    <form
      className="access-request-form"
      onSubmit={(event) => {
        event.preventDefault();
        onApprove(role, role === "owner" ? null : branchId);
      }}
    >
      <div className="request-identity">
        <div><span>ผู้ขอใช้งาน</span><strong>{request.displayName}</strong><small className="data-code">LINE: {request.lineUserId}</small></div>
        <div><span>ส่งคำขอเมื่อ</span><strong>{formatDate(request.requestedAt)}</strong></div>
      </div>
      <div className="grant-fields">
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
        <button type="submit" className="primary-button" disabled={pending || (role !== "owner" && !branchId)}>{pending ? "กำลังอนุมัติ…" : "อนุมัติคำขอ"}</button>
      </div>
    </form>
  );
}
