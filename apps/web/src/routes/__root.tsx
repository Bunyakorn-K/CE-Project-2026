import { createRootRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "../lib/components/app-shell";
import { LiffGate } from "../lib/components/liff-gate";

export const Route = createRootRoute({
  component: Root
});

function Root() {
  return (
    <LiffGate>
      <AppShell>
        <Outlet />
      </AppShell>
    </LiffGate>
  );
}