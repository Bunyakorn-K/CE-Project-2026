import { createFileRoute, redirect, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import type { AuthUser } from "../lib/atoms/auth";
import { authAtom } from "../lib/atoms/auth";
import { apiUrl } from "../lib/api/client";
import { AppShell } from "../lib/components/app-shell";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    const res = await fetch(apiUrl("/api/me"), { credentials: "include" });
    if (res.status === 401) throw redirect({ to: "/login" });
    if (!res.ok) throw new Error(`ไม่สามารถตรวจสอบเซสชันได้ (HTTP ${res.status})`);
  },
  component: AuthenticatedLayout
});

function AuthenticatedLayout() {
  const [user, setUser] = useAtom(authAtom);
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const navigate = useNavigate();

  useEffect(() => {
    fetch(apiUrl("/api/me"), { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) return null;
        const data = (await response.json()) as { user: { id: string; name: string; email: string }; grants: Array<{ role: string; branchId: string | null }> };
        const value: AuthUser = { id: data.user.id, name: data.user.name, email: data.user.email, roles: data.grants.map((grant) => grant.role), grants: data.grants };
        setUser(value);
        return value;
      })
      .catch(() => null)
      .finally(() => setStatus("ready"));
  }, [setUser]);

  useEffect(() => {
    if (status === "ready" && user === null) void navigate({ to: "/login", replace: true });
  }, [navigate, status, user]);

  if (status === "loading") return <main className="public-page"><section className="public-card liff-message-card" role="status" aria-live="polite"><span className="loading-orbit" /><h1>กำลังตรวจสอบเซสชัน</h1><p>กำลังโหลดสิทธิ์และขอบเขตของคุณ</p></section></main>;
  if (user === null) return <main className="public-page"><section className="public-card liff-message-card" role="status" aria-live="polite"><h1>กำลังพาไปหน้าเข้าสู่ระบบ</h1><p>เซสชันไม่พร้อมใช้งาน กรุณาเข้าสู่ระบบอีกครั้ง</p></section></main>;

  return <AppShell><Outlet /></AppShell>;
}
