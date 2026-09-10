import { createFileRoute, redirect } from "@tanstack/react-router";
import { Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { AuthUser } from "../lib/atoms/auth";
import { apiUrl } from "../lib/api/client";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout
});

function AuthenticatedLayout() {
  const [user, setUser] = useState<AuthUser | null | "loading">("loading");

  useEffect(() => {
    fetch(apiUrl("/api/me"), { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return null;
        const data = (await res.json()) as {
          user: { id: string; name: string; email: string };
          grants: Array<{ role: string; branchId: string | null }>;
        };
        return {
          id: data.user.id,
          name: data.user.name,
          email: data.user.email,
          roles: data.grants.map((g) => g.role),
          grants: data.grants
        };
      })
      .then((value) => setUser(value))
      .catch(() => setUser(null));
  }, []);

  if (user === "loading") {
    return <div className="flex min-h-screen items-center justify-center text-default-500">Loading…</div>;
  }

  if (user === null) {
    return null;
  }

  return <Outlet />;
}

export const guard = {
  beforeLoad: async ({ location }: { location: { href: string } }) => {
    const res = await fetch(apiUrl("/api/me"), { credentials: "include" });
    if (!res.ok) {
      throw redirect({
        to: "/login",
        search: { redirect: location.href }
      });
    }
  }
};