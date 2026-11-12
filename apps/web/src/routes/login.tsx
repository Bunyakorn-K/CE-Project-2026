import { createFileRoute, Link } from "@tanstack/react-router";
import { Button, Card, Form, Input, Label, TextField } from "@heroui/react";
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { apiErrorMessage, apiUrl } from "../lib/api/client";
import { authAtom } from "../lib/atoms/auth";
import { resetLiffLoginGuard, signInWithLiff } from "../liff";

export const Route = createFileRoute("/login")({
  component: LoginPage
});

type MeResponse = { user: { id: string; name: string; email: string }; grants: Array<{ role: string; branchId: string | null }> };

async function fetchMeAndSet(setUser: (user: MeResponse["user"] & { roles: string[]; grants: MeResponse["grants"] }) => void) {
  const response = await fetch(apiUrl("/api/me"), { credentials: "include" });
  if (!response.ok) throw new Error(await apiErrorMessage(response, "สร้างเซสชันแล้ว แต่ไม่สามารถโหลดข้อมูลผู้ใช้ได้"));
  const data = (await response.json()) as MeResponse;
  setUser({ id: data.user.id, name: data.user.name, email: data.user.email, roles: data.grants.map((grant) => grant.role), grants: data.grants });
  window.location.href = "/dashboard";
}

function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [configLoading, setConfigLoading] = useState(true);
  const [demoLoading, setDemoLoading] = useState(false);
  const [lineLoading, setLineLoading] = useState(false);
  const [, setUser] = useAtom(authAtom);

  useEffect(() => {
    fetch(apiUrl("/health"), { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("ตรวจสอบสถานะระบบไม่สำเร็จ");
        return (await response.json()) as { demoMode?: boolean };
      })
      .then((data) => setDemoMode(Boolean(data.demoMode)))
      .catch((nextError) => setConfigError(nextError instanceof Error ? nextError.message : "ตรวจสอบสถานะระบบไม่สำเร็จ"))
      .finally(() => setConfigLoading(false));
  }, []);

  async function onLineSignIn() {
    const liffId = import.meta.env.VITE_LIFF_ID as string | undefined;
    if (!liffId) {
      setError("ยังไม่ได้ตั้งค่า VITE_LIFF_ID สำหรับ LINE LIFF");
      return;
    }
    setLineLoading(true);
    setError(null);
    resetLiffLoginGuard();
    try {
      // One shared path, because the login button and the stale-session card
      // used to carry separate copies of this and diverge. `signInWithLiff`
      // decides between logging in, exchanging a live token, and renewing an
      // expired one; it returns null when it has fired liff.login() and the SDK
      // is navigating, so nothing below may run in that case.
      const identity = await signInWithLiff(liffId);
      if (!identity) return;
      const response = await fetch(apiUrl("/api/auth/liff/exchange"), { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ idToken: identity.idToken }) });
      if (!response.ok) throw new Error(await apiErrorMessage(response, "เข้าสู่ระบบด้วย LINE ไม่สำเร็จ"));
      resetLiffLoginGuard();
      await fetchMeAndSet(setUser);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "เข้าสู่ระบบด้วย LINE ไม่สำเร็จ");
    } finally {
      setLineLoading(false);
    }
  }

  async function onDemoSignIn() {
    setDemoLoading(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/demo/session"), { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error(await apiErrorMessage(response, "เข้าสู่ระบบ Demo ไม่สำเร็จ"));
      await fetchMeAndSet(setUser);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "เข้าสู่ระบบ Demo ไม่สำเร็จ");
    } finally {
      setDemoLoading(false);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/auth/sign-in/email"), { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ email, password }) });
      if (!response.ok) throw new Error(await apiErrorMessage(response, "เข้าสู่ระบบไม่สำเร็จ"));
      await fetchMeAndSet(setUser);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "เข้าสู่ระบบไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 max-[639px]:p-4">
      <Card variant="default" className="w-full max-w-[440px] rounded-2xl border border-border bg-surface p-8 shadow-overlay max-[639px]:p-5">
        <Card.Header className="mb-6 flex items-start gap-3.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent text-xs font-black tracking-widest text-accent-foreground" aria-hidden="true">LT</span>
          <div><h1>LaundryTwin</h1><p className="mt-1 text-xs text-muted">Operations workspace สำหรับผู้ดูแลร้านซักผ้าหลายสาขา</p></div>
        </Card.Header>
        <Card.Content>
          {configLoading && <p className="mb-3 text-xs text-muted" role="status">กำลังตรวจสอบโหมดระบบ</p>}
          {configError && <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-xs text-danger-soft-foreground" role="status">{configError} · การเข้าสู่ระบบด้วยอีเมลยังใช้ได้</p>}
          {demoMode && <div className="mb-4 grid gap-1 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-3 text-warning-soft-foreground"><strong>Demo mode</strong><span>ระบบกำลังใช้ข้อมูลจำลองสำหรับการทดสอบ ไม่ควรใช้เป็นข้อมูลปฏิบัติการจริง</span></div>}

          <div className="grid gap-2.5">
            {demoMode && <Button fullWidth variant="primary" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50" onPress={() => void onDemoSignIn()} isDisabled={demoLoading}>{demoLoading ? "กำลังเข้าสู่ระบบ Demo…" : "เข้าสู่ระบบ Demo · ข้อมูลจำลอง"}</Button>}
            <Button fullWidth variant="outline" className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover" onPress={() => void onLineSignIn()} isDisabled={lineLoading}>{lineLoading ? "กำลังเชื่อมต่อ LINE…" : "เข้าสู่ระบบด้วย LINE"}</Button>
          </div>

          <div className="my-5 flex items-center gap-2.5 text-[11px] text-muted">หรือใช้บัญชีอีเมล</div>
          <Form onSubmit={onSubmit} className="grid gap-3">
            <TextField isRequired name="email" type="email" value={email} onChange={setEmail}>
              <Label>อีเมล</Label>
              <Input autoComplete="email" placeholder="อีเมล" variant="secondary" />
            </TextField>
            <TextField isRequired name="password" type="password" value={password} onChange={setPassword}>
              <Label>รหัสผ่าน</Label>
              <Input autoComplete="current-password" placeholder="รหัสผ่าน" variant="secondary" />
            </TextField>
            {error && <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-xs text-danger-soft-foreground" role="alert">{error}</p>}
            <Button fullWidth type="submit" variant="primary" isDisabled={loading}>{loading ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบด้วยอีเมล"}</Button>
          </Form>
          <nav className="mt-5 flex flex-wrap items-center gap-2 text-xs text-muted" aria-label="ข้อกำหนดและนโยบาย"><Link to="/privacy">นโยบายความเป็นส่วนตัว</Link><span aria-hidden="true">·</span><Link to="/terms">ข้อกำหนดการใช้งาน</Link></nav>
        </Card.Content>
      </Card>
    </main>
  );
}
