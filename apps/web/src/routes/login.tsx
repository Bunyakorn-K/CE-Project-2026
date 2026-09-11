import { createFileRoute } from "@tanstack/react-router";
import { Button, Card, Input } from "@heroui/react";
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { apiUrl } from "../lib/api/client";
import { authAtom } from "../lib/atoms/auth";

export const Route = createFileRoute("/login")({
  component: LoginPage
});

type MeResponse = {
  user: { id: string; name: string; email: string };
  grants: Array<{ role: string; branchId: string | null }>;
};

async function fetchMeAndSet(setUser: (u: MeResponse["user"] & { roles: string[]; grants: MeResponse["grants"] }) => void) {
  const me = await fetch(apiUrl("/api/me"), { credentials: "include" });
  if (!me.ok) throw new Error("Session created but /api/me failed");
  const data = (await me.json()) as MeResponse;
  setUser({
    id: data.user.id,
    name: data.user.name,
    email: data.user.email,
    roles: data.grants.map((g) => g.role),
    grants: data.grants
  });
  window.location.href = "/dashboard";
}

function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [, setUser] = useAtom(authAtom);

  useEffect(() => {
    fetch(apiUrl("/health"), { credentials: "include" })
      .then((r) => r.json().catch(() => null))
      .then((d) => setDemoMode(Boolean(d?.demoMode)))
      .catch(() => {});
  }, []);

  // Demo sign-in (explicit — the deploy runs in demo mode; no password
  // accounts exist in the DB, so email/password would always fail).
  async function onDemoSignIn() {
    setDemoLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/demo/session"), { method: "POST", credentials: "include" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(data?.error?.message ?? "Demo sign-in failed");
      }
      await fetchMeAndSet(setUser);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demo sign-in failed");
    } finally {
      setDemoLoading(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/auth/sign-in/email"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password })
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? "Login failed");
      }
      await fetchMeAndSet(setUser);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <div className="flex flex-col gap-4 p-4">
          <div>
            <h1 className="mb-1 text-xl font-bold">LaundroTwin</h1>
            <p className="text-sm text-default-500">Backoffice sign in</p>
          </div>

          {demoMode && (
            <div className="flex flex-col gap-1 rounded-lg bg-warning/10 p-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-warning">Demo mode</span>
              <span className="text-xs text-default-500">
                This deployment runs with synthetic data. Use the demo session to explore.
              </span>
            </div>
          )}

          <Button variant="primary" onPress={() => void onDemoSignIn()} isDisabled={demoLoading}>
            {demoLoading ? "Signing in…" : "Sign in as Demo Owner"}
          </Button>

          <div className="flex items-center gap-2 text-xs text-default-400">
            <div className="h-px flex-1 bg-divider" />
            <span>or with email &amp; password</span>
            <div className="h-px flex-1 bg-divider" />
          </div>

          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span>Email</span>
              <Input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>Password</span>
              <Input
                placeholder="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" isDisabled={loading}>
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}