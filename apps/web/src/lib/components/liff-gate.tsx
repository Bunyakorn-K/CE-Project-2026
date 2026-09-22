import type { LiffIdentity } from "../../liff";
import { initLiff } from "../../liff";
import type { PropsWithChildren } from "react";
import { useEffect, useState } from "react";
import { apiUrl } from "../api/client";

/**
 * Gate ALL rendering until the LIFF SDK has initialized AND, when a LINE
 * session exists, we have exchanged its ID token for our own session cookie.
 *
 * Why this must wrap the router (not live inside the root route):
 *
 * TanStack Router resolves the initial redirect chain — `/` → `/dashboard`
 * → `/login` — during the first load before any route component mounts.
 * Our `/` route redirects to `/dashboard`, whose beforeLoad guard fetches
 * `/api/me`, gets 401, and redirects to `/login`. If `liff.init()` has not
 * run yet at that moment, the SDK never sees the `?code=` parameter that
 * LINE's authorize endpoint returned, never exchanges it, reports
 * not-logged-in, and calls `liff.login()` again — an endless loop with a
 * fresh `code` on every cycle (confirmed in the nginx access log).
 *
 * Running init + exchange here, above the router, means the URL still holds
 * the auth code while the SDK consumes it. Pattern follows the reference
 * implementation, where the equivalent provider wraps RouterProvider.
 *
 * Error handling: a failed init is fatal (the app cannot function inside
 * LINE without the SDK). Surfaces a retry screen instead of a silent hang.
 * Outside a LINE context the SDK throws; initLiff resolves null and we
 * render immediately so desktop browsers reach the login page.
 *
 * ACCESS_PENDING is expected on first use — the server records the request
 * and an administrator approves it. That is not an error to retry through
 * LINE; it needs a human, so it gets its own message.
 */
type State = "loading" | "ready" | "error";
type Phase = "init" | "exchange" | "session";

type ExchangeResponse = {
  user: { id: string; name: string; email: string };
  roles: string[];
};

type ApiErrorResponse = {
  error?: { code?: string; message?: string };
};

function LiffGateMessage({ phase, message }: { phase: Phase; message: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6">
      <p className="text-sm text-danger">
        [{phase}] {message}
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-md bg-primary px-4 py-2 text-sm font-bold text-white"
      >
        ลองใหม่
      </button>
    </div>
  );
}

/**
 * Exchange a LINE ID token for our own session cookie. Returns null when the
 * LINE identity is unknown to us — the server records a pending access
 * request in that case, which is a normal first-use flow, not a failure.
 */
async function exchangeIdentity(
  identity: LiffIdentity,
  signal: AbortSignal
): Promise<ExchangeResponse | null> {
  const res = await fetch(apiUrl("/api/auth/liff/exchange"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ idToken: identity.idToken }),
    signal
  });
  if (res.status === 403) {
    const data = (await res.json().catch(() => null)) as ApiErrorResponse | null;
    if (data?.error?.code === "ACCESS_PENDING") {
      return null;
    }
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as ApiErrorResponse | null;
    throw new Error(data?.error?.message ?? `LINE exchange failed (HTTP ${res.status})`);
  }
  return (await res.json()) as ExchangeResponse;
}

export function LiffGate({ children }: PropsWithChildren) {
  const [state, setState] = useState<State>("loading");
  const [phase, setPhase] = useState<Phase>("init");
  const [error, setError] = useState<string | null>(null);
  const [pendingAccess, setPendingAccess] = useState(false);

  useEffect(() => {
    const liffId = import.meta.env.VITE_LIFF_ID as string | undefined;
    // Outside a LINE context there is no LIFF ID to init against — the login
    // page handles email/demo sign-in on desktop browsers.
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

        // initLiff resolves null when the SDK throws — i.e. a plain browser,
        // not the LINE client. There is no LINE session to obtain here.
        if (!liff) {
          setState("ready");
          return;
        }

        // Inside LINE the SDK handles the authorize round-trip itself during
        // init: it exchanges ?code= for tokens and reports isLoggedIn().
        // When it reports no session it has already decided login() is
        // required (the SDK fired login internally and threw INIT_FAILED
        // before initLiff could resolve), so it is mid-redirect — calling
        // login() ourselves would only start a second, racing round-trip.
        if (!liff.isLoggedIn()) {
          setState("ready");
          return;
        }

        const [profile, idToken] = await Promise.all([
          liff.getProfile(),
          liff.getIDToken()
        ]);
        if (cancelled) return;
        if (!idToken) {
          throw new Error("LINE did not provide an ID token for this LIFF app");
        }

        setPhase("exchange");
        const exchanged = await exchangeIdentity(
          { displayName: profile.displayName, userId: profile.userId, idToken },
          controller.signal
        );
        if (cancelled) return;

        // Unknown LINE identity: the server recorded a pending access
        // request. This is the expected first-use path — an administrator
        // must approve it. Not retriable through LINE.
        if (exchanged === null) {
          setPendingAccess(true);
          setState("ready");
          return;
        }

        setPhase("session");
        // The exchange set our session cookie; the route guards trust it.
        // Validate it now so a cookie that failed to land surfaces here
        // instead of bouncing through /dashboard → /login.
        const me = await fetch(apiUrl("/api/me"), {
          credentials: "include",
          signal: controller.signal
        });
        if (cancelled) return;
        if (!me.ok) {
          throw new Error(`Session was created but /api/me failed (HTTP ${me.status})`);
        }

        setState("ready");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "LINE initialization failed");
        setState("error");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  if (state === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center text-default-500">
        Loading…
      </div>
    );
  }

  if (state === "error" && error) {
    return <LiffGateMessage phase={phase} message={error} />;
  }

  if (pendingAccess) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-sm text-sm text-default-600">
          บัญชี LINE ของคุณรอการอนุมัติจากผู้ดูแลระบบ
        </p>
        <p className="max-w-sm text-xs text-default-400">
          Your LINE account is waiting for an administrator to approve access.
          Please reopen the app later.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-bold text-white"
        >
          ลองใหม่
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
