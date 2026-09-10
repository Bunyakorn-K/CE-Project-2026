import { createFileRoute, redirect } from "@tanstack/react-router";
import { Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import type { AuthUser } from "../lib/atoms/auth";
import { authAtom } from "../lib/atoms/auth";
import { apiUrl } from "../lib/api/client";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout
});

function AuthenticatedLayout() {
  const [user, setUser] = useAtom(authAtom);
  const [status, setStatus] = useState<"loading" | "ready">("loading");

  useEffect(() => {
    fetch(apiUrl("/api/me"), { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return null;
        const data = (await res.json()) as {
          user: { id: string; name: string; email: string };
          grants: Array<{ role: string; branchId: string | null }>;
        };
        const value: AuthUser = {
          id: data.user.id,
          name: data.user.name,
          email: data.user.email,
          roles: data.grants.map((g) => g.role),
          grants: data.grants
        };
        setUser(value);
        return value;
      })
      .catch(() => null)
      .finally(() => setStatus("ready"));
  }, [setUser]);

  if (status === "loading") {
    return <div className="flex min-h-screen items-center justify-center text-default-500">Loading…</div>;
  }

  if (user === null) {
    const path = window.location.pathname + window.location.search;
    window.location.href = `/login?redirect=${encodeURIComponent(path)}`;
    return null;
  }

  return <Outlet />;
}