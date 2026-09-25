import type { LiffIdentity } from "../../liff";
import { getLiffInitError, initLiff } from "../../liff";
import type { PropsWithChildren } from "react";
import { useEffect, useState } from "react";
import { apiUrl } from "../api/client";

type State = "loading" | "ready" | "error";
type Phase = "init" | "exchange" | "session";
type ExchangeResponse = { user: { id: string; name: string; email: string }; roles: string[] };
type ApiErrorResponse = { error?: { code?: string; message?: string } };

function LiffGateMessage({ phase, message }: { phase: Phase; message: string }) {
  const heading = phase === "init" ? "เริ่ม LINE LIFF ไม่สำเร็จ" : phase === "exchange" ? "แลกเปลี่ยนข้อมูล LINE ไม่สำเร็จ" : "ตรวจสอบเซสชันไม่สำเร็จ";
  return (
    <main className="public-page liff-public-page">
      <section className="public-card liff-message-card" role="alert" aria-live="assertive">
        <span className="brand-symbol" aria-hidden="true">LT</span>
        <h1>{heading}</h1>
        <p>{message}</p>
        <button type="button" onClick={() => window.location.reload()} className="primary-button">ลองใหม่</button>
      </section>
    </main>
  );
}

async function exchangeIdentity(identity: LiffIdentity, signal: AbortSignal): Promise<ExchangeResponse | null> {
  const response = await fetch(apiUrl("/api/auth/liff/exchange"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ idToken: identity.idToken }),
    signal
  });
  if (response.status === 403) {
    const data = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    if (data?.error?.code === "ACCESS_PENDING") return null;
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    throw new Error(data?.error?.message ?? `LINE exchange failed (HTTP ${response.status})`);
  }
  return (await response.json()) as ExchangeResponse;
}

export function LiffGate({ children }: PropsWithChildren) {
  const [state, setState] = useState<State>("loading");
  const [phase, setPhase] = useState<Phase>("init");
  const [error, setError] = useState<string | null>(null);
  const [pendingAccess, setPendingAccess] = useState(false);

  useEffect(() => {
    const liffId = import.meta.env.VITE_LIFF_ID as string | undefined;
    if (!liffId) {
      setState("ready");
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const liff = await initLiff(liffId);
        if (cancelled) return;
        if (!liff) {
          const reason = getLiffInitError();
          if (reason) throw reason;
          setState("ready");
          return;
        }
        if (!liff.isLoggedIn()) {
          setState("ready");
          return;
        }
        const [profile, idToken] = await Promise.all([liff.getProfile(), liff.getIDToken()]);
        if (cancelled) return;
        if (!idToken) throw new Error("LINE did not provide an ID token for this LIFF app");
        setPhase("exchange");
        const exchanged = await exchangeIdentity({ displayName: profile.displayName, userId: profile.userId, idToken }, controller.signal);
        if (cancelled) return;
        if (exchanged === null) {
          setPendingAccess(true);
          setState("ready");
          return;
        }
        setPhase("session");
        const me = await fetch(apiUrl("/api/me"), { credentials: "include", signal: controller.signal });
        if (cancelled) return;
        if (!me.ok) throw new Error(`Session was created but /api/me failed (HTTP ${me.status})`);
        setState("ready");
      } catch (nextError) {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : "LINE initialization failed");
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  if (state === "loading") {
    return <main className="public-page liff-public-page"><section className="public-card liff-message-card" role="status" aria-live="polite"><span className="loading-orbit" /><h1>กำลังตรวจสอบ LINE</h1><p>กำลังเตรียมเซสชันและตรวจสอบสิทธิ์เข้าใช้งาน</p></section></main>;
  }

  if (state === "error") return <LiffGateMessage phase={phase} message={error ?? "ไม่สามารถเริ่ม LINE LIFF ได้"} />;

  if (state === "ready" && pendingAccess) {
    return <main className="public-page liff-public-page"><section className="public-card liff-message-card" role="status"><span className="status-pill status-pill--warning">รอการอนุมัติ</span><h1>ส่งคำขอเข้าใช้งานแล้ว</h1><p>กรุณารอผู้ดูแลระบบอนุมัติสิทธิ์ แล้วเปิดหน้านี้อีกครั้ง</p></section></main>;
  }

  return <>{children}</>;
}
