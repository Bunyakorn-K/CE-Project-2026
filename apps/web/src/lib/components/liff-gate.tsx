import { initLiff } from "../../liff";
import type { PropsWithChildren } from "react";
import { useEffect, useState } from "react";

/**
 * Gate ALL rendering until the LIFF SDK has initialized.
 *
 * The SDK must finish `liff.init()` before `isLoggedIn()` means anything.
 * Rendering routes before that resolves lets a `beforeLoad` guard or an
 * effect read a half-initialized SDK — observed as "No default value" on
 * first load, and as a login loop after refresh (the not-yet-initialized
 * SDK reports not-logged-in, so the app fires `liff.login()` again).
 *
 * Pattern follows the reference implementation: init once at boot, then
 * decide: if logged in, exchange; if not, `liff.login({ redirectUri })`
 * exactly once. A sessionStorage counter caps retries so a stale id token
 * can never redirect forever.
 */
const ATTEMPT_KEY = "liff_login_attempt";
const MAX_ATTEMPTS = 3;

type State = "loading" | "ready" | "error";

function readAttempts(): number {
  if (typeof window === "undefined") return 0;
  const n = Number(window.sessionStorage.getItem(ATTEMPT_KEY));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function bumpAttempts(): number {
  if (typeof window === "undefined") return readAttempts() + 1;
  const next = readAttempts() + 1;
  window.sessionStorage.setItem(ATTEMPT_KEY, String(next));
  return next;
}

export function resetLiffAttempts(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(ATTEMPT_KEY);
}

export function LiffGate({ children }: PropsWithChildren) {
  const [state, setState] = useState<State>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const liffId = import.meta.env.VITE_LIFF_ID as string | undefined;
    // Outside a LINE context (plain browser) there is nothing to gate on —
    // the login page handles its own sign-in flow.
    if (!liffId) {
      setState("ready");
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const liff = await initLiff(liffId);
        if (cancelled) return;

        // initLiff resolves null when the SDK throws — i.e. we are in a plain
        // browser, not the LINE client. There is no LINE session to obtain, so
        // render the app (the login page handles email/demo sign-in).
        if (!liff) {
          setState("ready");
          return;
        }

        if (!liff.isLoggedIn()) {
          if (readAttempts() >= MAX_ATTEMPTS) {
            setError("LINE sign-in failed repeatedly. Please reopen the app.");
            setState("error");
            return;
          }
          bumpAttempts();
          // redirectUri lands them back here; the gate runs again, this time
          // with a LINE session, so the exchange proceeds.
          liff.login({ redirectUri: window.location.href });
          return;
        }

        if (cancelled) return;
        resetLiffAttempts();
        setState("ready");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "LINE initialization failed");
        setState("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center text-default-500">
        Loading…
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6">
        <p className="text-sm text-danger">{error}</p>
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
