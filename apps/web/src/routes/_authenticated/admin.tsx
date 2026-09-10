import { createFileRoute, redirect } from "@tanstack/react-router";
import { Outlet } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { authAtom } from "../../lib/atoms/auth";

export const Route = createFileRoute("/_authenticated/admin")({
  component: AdminLayout
});

function AdminLayout() {
  const [user] = useAtom(authAtom);
  const [status, setStatus] = useState<"checking" | "ready">("checking");

  // authAtom is populated by the parent _authenticated layout; we only need a
  // beat so the atom settles after hydration.
  useEffect(() => {
    const t = setTimeout(() => setStatus("ready"), 0);
    return () => clearTimeout(t);
  }, []);

  if (status === "checking" || user === null) {
    return <div className="flex min-h-screen items-center justify-center text-default-500">Loading…</div>;
  }

  const isOwner = user.grants.some((g) => g.role === "owner");
  if (!isOwner) {
    window.location.href = "/dashboard";
    return null;
  }

  return <Outlet />;
}