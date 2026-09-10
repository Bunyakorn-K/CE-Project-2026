import { createFileRoute } from "@tanstack/react-router";
import { Button, Card, Input } from "@heroui/react";
import { useState } from "react";
import { useAtom } from "jotai";
import { apiUrl } from "../lib/api/client";
import { authAtom } from "../lib/atoms/auth";

export const Route = createFileRoute("/login")({
  component: LoginPage
});

function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [, setUser] = useAtom(authAtom);

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

      // Populate the shared auth atom so the backoffice shell renders nav
      // immediately, then go to the dashboard.
      const me = await fetch(apiUrl("/api/me"), { credentials: "include" });
      if (me.ok) {
        const data = (await me.json()) as {
          user: { id: string; name: string; email: string };
          grants: Array<{ role: string; branchId: string | null }>;
        };
        setUser({
          id: data.user.id,
          name: data.user.name,
          email: data.user.email,
          roles: data.grants.map((g) => g.role),
          grants: data.grants
        });
      }
      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <div className="p-4">
          <h1 className="mb-1 text-xl font-bold">LaundroTwin</h1>
          <p className="mb-4 text-sm text-default-500">Backoffice sign in</p>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span>Email</span>
              <Input
                placeholder="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
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