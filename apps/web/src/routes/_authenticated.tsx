import { createFileRoute, redirect, Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import type { AuthUser } from "../lib/atoms/auth";
import { authAtom } from "../lib/atoms/auth";
import { apiUrl } from "../lib/api/client";

export const Route = createFileRoute("/_authenticated")({
  // Auth guard lives in beforeLoad so the redirect happens in the router
  // before anything renders. A hard window.location reload (the old approach)
  // would discard React state and re-fire the login page's LIFF effects on
  // every bounce, looping with the LINE redirect flow.
  beforeLoad: async ({ location }) => {
    let authenticated = false;
    try {
      const res = await fetch(apiUrl("/api/me"), { credentials: "include" });
      authenticated = res.ok;
    } catch {
      authenticated = false;
    }
    if (!authenticated) {
      throw redirect({
        to: "/login",
        search: { redirect: location.pathname + location.search }
      });
    }
  },
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
    // beforeLoad already redirected here; this branch is only reachable if
    // the session expired after mount. Reload once so the guard re-runs
    // instead of bouncing forever inside the router.
    window.location.reload();
    return null;
  }

  return <Outlet />;
}
