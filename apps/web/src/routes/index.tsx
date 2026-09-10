import { createFileRoute, redirect } from "@tanstack/react-router";

// Landing: LIFF flows open the dashboard directly; desktop users are sent to
// the login page when unauthenticated (guard lives in _authenticated).
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard" });
  }
});