import type { LiffIdentity } from "../../liff";
import { getLiffInitError, initLiff, missingIdTokenReason } from "../../liff";
import { router } from "../../router";
import type { PropsWithChildren } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
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

/**
 * Routes that must stay readable no matter what the LINE session says.
 *
 * A privacy policy and a terms page are legal documents, not product surface.
 * Gating them means a user who is signed in but not yet granted access cannot
 * read the policy that governs their data — and a LINE reviewer following the
 * Privacy policy URL lands on the pending card instead of the document. Both
 * make the policy harder to produce, not easier.
 *
 * The URL is public and the pages hold no branch data, so the gate's only
 * effect here is to hide them.
 */
const UNGATED_PATHS = new Set(["/privacy", "/terms"]);

export function isUngatedPath(pathname: string): boolean {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return UNGATED_PATHS.has(normalized);
}

/**
 * The slice of the router this gate needs: a current path, and a subscription
 * that fires when navigation resolves.
 *
 * The gate has to stay *above* the RouterProvider, not inside the router as a
 * layout route. `_authenticated`'s `beforeLoad` fetches `/api/me` and redirects
 * on 401, and `beforeLoad` runs before any effect — so if the token exchange
 * lived in the route tree, that fetch would fire before the ID token had been
 * traded for a session cookie and a legitimate first sign-in would always
 * bounce to /login. `useRouterState` needs provider context, which is exactly
 * what is not available up here, so the path is read off the router instance
 * instead. It carries `latestLocation` from its own constructor, so the value
 * is correct on the very first render, before the provider has mounted.
 */
export type PathSource = {
  subscribe: (onChange: () => void) => () => void;
  getPath: () => string;
};

/** Subscribes to `onResolved`, so the gate re-renders after each navigation. */
export function createRouterPathSource(source: {
  subscribe: (event: "onResolved", listener: () => void) => () => void;
  latestLocation: { pathname: string };
}): PathSource {
  return {
    subscribe: (onChange) => source.subscribe("onResolved", onChange),
    getPath: () => source.latestLocation.pathname
  };
}

const routerPathSource = createRouterPathSource(router);

function useCurrentPath(pathSource: PathSource): string {
  return useSyncExternalStore(pathSource.subscribe, pathSource.getPath, pathSource.getPath);
}

export function LiffGate({ children }: PropsWithChildren) {
  const [state, setState] = useState<State>("loading");
  const [phase, setPhase] = useState<Phase>("init");
  const [error, setError] = useState<string | null>(null);
  const [pendingAccess, setPendingAccess] = useState(false);
  const pathname = useCurrentPath(routerPathSource);
  const bypass = isUngatedPath(pathname);

  // The effect below runs on every path, including the ungated ones. That is
  // deliberate: it establishes the session for the app as a whole, so a user
  // who reads the policy first and signs in afterwards is already exchanged.
  // `bypass` only decides what is *rendered* while that happens — the gate is
  // not skipped, its blocking UI is.
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
        if (!idToken) throw new Error(await missingIdTokenReason(liff));
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

  if (bypass) return <>{children}</>;

  if (state === "loading") {
    return <main className="public-page liff-public-page"><section className="public-card liff-message-card" role="status" aria-live="polite"><span className="loading-orbit" /><h1>กำลังตรวจสอบ LINE</h1><p>กำลังเตรียมเซสชันและตรวจสอบสิทธิ์เข้าใช้งาน</p></section></main>;
  }

  if (state === "error") return <LiffGateMessage phase={phase} message={error ?? "ไม่สามารถเริ่ม LINE LIFF ได้"} />;

  if (state === "ready" && pendingAccess) {
    return <main className="public-page liff-public-page"><section className="public-card liff-message-card" role="status"><span className="status-pill status-pill--warning">รอการอนุมัติ</span><h1>ส่งคำขอเข้าใช้งานแล้ว</h1><p>กรุณารอผู้ดูแลระบบอนุมัติสิทธิ์ แล้วเปิดหน้านี้อีกครั้ง</p></section></main>;
  }

  return <>{children}</>;
}
