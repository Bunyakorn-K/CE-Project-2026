import { createRootRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "../lib/components/app-shell";

export const Route = createRootRoute({
  component: Root
});

function Root() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}