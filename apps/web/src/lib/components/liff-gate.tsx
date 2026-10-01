import type { LiffIdentity } from "../../liff";
import {
  getLiffInitError,
  initLiff,
  isIdTokenExpired,
  missingIdTokenReason,
  signInWithLiff,
  staleLiffSessionMessage
} from "../../liff";
import { router } from "../../router";
import type { PropsWithChildren } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { apiUrl } from "../api/client";

type State = "loading" | "ready" | "error" | "stale";
type Phase = "init" | "exchange" | "session";
type ExchangeResponse = { user: { id: string; name: string; email: string }; roles: string[] };
type ApiErrorResponse = { error?: { code?: string; message?: string } };

/**
 * A machine-readable reason, as opposed to the SDK's own English prose.
 *
 * The gate renders on a Thai-first page, and `initLiff` surfaces the raw
 * failure it caught — so a network drop reached the visitor as the card body
 * reading "Failed to fetch", verbatim, inside an otherwise Thai sentence. This
 * is the same defect `api-errors.ts` exists to prevent on the API side: a
 * server-side string must never be the user-facing copy.
 */
function liffFailureMessage(phase: Phase, detail: string | null): string {
  // The detail is dropped, not translated. `getLiffInitError()` carries LINE's
  // own wording, which is neither stable enough to match on nor ours to render;
  // what the visitor can act on is which step failed and what to do next.
  if (phase === "init") {
    return "ไม่สามารถเชื่อมต่อกับ LINE ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่";
  }
  if (phase === "exchange") {
    return "แลกเปลี่ยนข้อมูลกับ LINE ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
  }
  // `detail` is deliberately unread here: naming it would put the SDK's English
  // back on the page. It stays a parameter so the failure text is still
  // available to a caller that wants to log it.
  void detail;
  return "ตรวจสอบเซสชันไม่สำเร็จ กรุณาลองใหม่";
}

function LiffGateMessage({ phase, message, onRetry }: { phase: Phase; message: string; onRetry?: () => void }) {
  const heading = phase === "init" ? "เริ่ม LINE LIFF ไม่สำเร็จ" : phase === "exchange" ? "แลกเปลี่ยนข้อมูล LINE ไม่สำเร็จ" : "ตรวจสอบเซสชันไม่สำเร็จ";
  return (
    <main className="public-page liff-public-page">
      <section className="public-card liff-message-card" role="alert" aria-live="assertive">
        <span className="brand-symbol" aria-hidden="true">LT</span>
        <h1>{heading}</h1>
        <p>{message}</p>
        {/* When a fresh token is what is needed, re-login is the action. A reload
            would re-run the identical exchange against the same stale token. */}
        <button type="button" onClick={onRetry ?? (() => window.location.reload())} className="primary-button">
          {onRetry ? "เข้าสู่ระบบด้วย LINE อีกครั้ง" : "ลองใหม่"}
        </button>
        {/* The way out for anyone the LINE button cannot help.
            This card replaces the whole page, so without this a visitor whose
            problem is not LINE — no LINE client, a browser they cannot use it
            in — is left with a retry of the request that just failed. */}
        <p className="liff-message-alt">
          <a href="/login">เข้าสู่ระบบด้วยอีเมลแทน</a>
        </p>
      </section>
    </main>
  );
}

/**
 * Sign in again, discarding the stale token.
 *
 * `liff.logout()` is what clears the cached token; without it the SDK replays
 * the same expired one and the re-login lands back where it started. The plan
 * decides whether a logout is needed at all — on this card the token is known
 * dead, but going through the same shared decision keeps one code path from
 * diverging again.
 */
function reauthenticateWithLiff(liffId: string): void {
  void (async () => {
    await signInWithLiff(liffId);
    // `logout()` is documented to clear the session and return nothing, NOT to
    // navigate, so the reload cannot be assumed. When it does fire liff.login()
    // this is redundant; when it only cleared the cache, this is what puts the
    // user back on a clean page that can run a fresh exchange.
    window.location.reload();
  })();
}

class LiffExchangeError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "LiffExchangeError";
  }
}

/**
 * A token the API refused, as opposed to an API that could not be reached.
 *
 * Only the former is fixed by signing in again. A 502 or 503 means LINE or the
 * channel config is the problem, and re-logging the user in would be noise.
 */
function isRejectedTokenError(error: unknown): boolean {
  return error instanceof LiffExchangeError && error.status === 401;
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
    throw new LiffExchangeError(
      data?.error?.message ?? `LINE exchange failed (HTTP ${response.status})`,
      response.status
    );
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
 * `/login` is here for the same reason and one more. It IS the sign-in surface:
 * it carries the email form, the demo button and the legal links. A stale LINE
 * session replaced all three with a card whose only action was "sign in with
 * LINE again", so a browser user who cannot use LINE had no way forward at all
 * — verified in production 2026-10-01, where /login rendered nothing but the
 * stale card. The URL is public and none of these pages hold branch data, so
 * the gate's only effect here is to hide them.
 */
const UNGATED_PATHS = new Set(["/login", "/privacy", "/terms"]);

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

/** What the gate puts on screen. `render` means the route renders as usual. */
export type GateDecision = "render" | "loading" | "stale" | "error" | "pending";

/**
 * What the gate should show, as a pure function of four facts.
 *
 * The defect this encodes is only reachable with a browser whose LIFF cache
 * holds an expired ID token *while the API has already issued a working
 * session* — measured on production 2026-10-01, where `/api/me` answered 200
 * with an owner grant and `/dashboard` still refused to render, showing
 * "เซสชัน LINE หมดอายุแล้ว". No button press reproduces that, so it is decided
 * here instead and tested without a LINE client.
 *
 * The rule: an ID token is what CREATES a session. Once `/api/me` says one
 * exists, an expired copy cached in the browser says nothing about whether that
 * session is still good — the API owns that answer, and it has already given
 * it. Blocking on the cached token then locks a signed-in owner out of the
 * product on the strength of a value the server never re-checked.
 */
export function decideGate(input: {
  bypass: boolean;
  state: State;
  pendingAccess: boolean;
  sessionUsable: boolean;
}): GateDecision {
  if (input.bypass) return "render";
  if (input.state === "loading") return "loading";
  if (input.sessionUsable) return "render";
  if (input.state === "stale") return "stale";
  if (input.state === "error") return "error";
  if (input.state === "ready" && input.pendingAccess) return "pending";
  return "render";
}

/**
 * Whether the API will vouch for this browser right now.
 *
 * `ok` alone, not the body: `/api/me` answers 401 without a session and 200
 * with one, and the grants inside it are the authenticated routes' business to
 * enforce. A network failure is `false` — the gate then falls back to its LINE
 * card, which is the conservative answer.
 */
async function probeSession(signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(apiUrl("/api/me"), { credentials: "include", signal });
    return response.ok;
  } catch {
    return false;
  }
}

export function LiffGate({ children }: PropsWithChildren) {
  const [state, setState] = useState<State>("loading");
  const [phase, setPhase] = useState<Phase>("init");
  const [error, setError] = useState<string | null>(null);
  const [pendingAccess, setPendingAccess] = useState(false);
  const [sessionUsable, setSessionUsable] = useState(false);
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
        // Checked BEFORE the exchange. LIFF reports a stale token as a perfectly
        // good one — isLoggedIn() is true and getIDToken() returns it happily —
        // so the API is the only place the expiry surfaces, and its answer is
        // an opaque failure. Catching it here lets the user re-login instead of
        // retrying an exchange that cannot succeed.
        if (isIdTokenExpired(idToken)) {
          setSessionUsable(await probeSession(controller.signal));
          if (cancelled) return;
          setState("stale");
          return;
        }
        setPhase("exchange");
        const exchanged = await exchangeIdentity({ displayName: profile.displayName, userId: profile.userId, idToken }, controller.signal);
        if (cancelled) return;
        if (exchanged === null) {
          setSessionUsable(await probeSession(controller.signal));
          if (cancelled) return;
          setPendingAccess(true);
          setState("ready");
          return;
        }
        setPhase("session");
        const me = await fetch(apiUrl("/api/me"), { credentials: "include", signal: controller.signal });
        if (cancelled) return;
        if (!me.ok) throw new Error(`Session was created but /api/me failed (HTTP ${me.status})`);
        setSessionUsable(true);
        setState("ready");
      } catch (nextError) {
        if (cancelled) return;
        // A 401 from the exchange means the token is no longer usable — it can
        // expire between the check above and the response. Route it to the same
        // re-login path rather than showing a dead "try again".
        if (isRejectedTokenError(nextError)) {
          setSessionUsable(await probeSession(controller.signal));
          if (cancelled) return;
          setState("stale");
          return;
        }
        // Same reasoning as the 401 branch: a LINE failure blocks only the
        // people who still need LINE to get a session. Probed last so a genuine
        // outage does not add a request on top of the one that just failed.
        setSessionUsable(await probeSession(controller.signal));
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

  switch (decideGate({ bypass, state, pendingAccess, sessionUsable })) {
    case "render":
      return <>{children}</>;

    case "loading":
      return <main className="public-page liff-public-page"><section className="public-card liff-message-card" role="status" aria-live="polite"><span className="loading-orbit" /><h1>กำลังตรวจสอบ LINE</h1><p>กำลังเตรียมเซสชันและตรวจสอบสิทธิ์เข้าใช้งาน</p></section></main>;

    case "stale":
      return (
        <LiffGateMessage
          phase="exchange"
          message={staleLiffSessionMessage()}
          onRetry={() => reauthenticateWithLiff(import.meta.env.VITE_LIFF_ID as string)}
        />
      );

    case "error":
      return <LiffGateMessage phase={phase} message={liffFailureMessage(phase, error)} />;

    case "pending":
      return <main className="public-page liff-public-page"><section className="public-card liff-message-card" role="status"><span className="status-pill status-pill--warning">รอการอนุมัติ</span><h1>ส่งคำขอเข้าใช้งานแล้ว</h1><p>กรุณารอผู้ดูแลระบบอนุมัติสิทธิ์ แล้วเปิดหน้านี้อีกครั้ง</p></section></main>;
  }
}
