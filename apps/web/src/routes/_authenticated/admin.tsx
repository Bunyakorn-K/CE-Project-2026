import { createFileRoute, redirect } from "@tanstack/react-router";
import { Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { apiUrl } from "../../lib/api/client";

export const Route = createFileRoute("/_authenticated/admin")({
  component: AdminLayout
});

function AdminLayout() {
  const [isOwner, setIsOwner] = useState<boolean | "loading">("loading");

  useEffect(() => {
    fetch(apiUrl("/api/me"), { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return false;
        const data = (await res.json()) as {
          grants: Array<{ role: string; branchId: string | null }>;
        };
        return data.grants.some((g) => g.role === "owner");
      })
      .then(setIsOwner)
      .catch(() => setIsOwner(false));
  }, []);

  if (isOwner === "loading") {
    return <div className="flex min-h-screen items-center justify-center text-default-500">Loading…</div>;
  }

  if (!isOwner) {
    return null; // guard redirects below
  }

  return <Outlet />;
}

export const guard = {
  beforeLoad: async ({ location }: { location: { href: string } }) => {
    const res = await fetch(apiUrl("/api/me"), { credentials: "include" });
    if (!res.ok) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
    const data = (await res.json()) as { grants: Array<{ role: string }> };
    if (!data.grants.some((g) => g.role === "owner")) {
      throw redirect({ to: "/dashboard" });
    }
  }
};