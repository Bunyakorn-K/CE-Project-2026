import type { LiffIdentity } from "../../liff";
import {
  bumpRenewAttempts,
  closeLiffWindow,
  getLiffInitError,
  initLiff,
  isIdTokenExpired,
  isLiffInClient,
  isLiffSignedOut,
  missingIdTokenReason,
  readRenewAttempts,
  resetLiffLoginGuard,
  resetRenewAttempts,
  signInWithLiff,
  staleLiffSessionMessage
} from "../../liff";
import { router } from "../../router";
import type { PropsWithChildren } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { apiUrl } from "../api/client";

type State = "loading" | "ready" | "error" | "stale" | "terminal" | "denied";
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
    <main className="grid min-h-screen place-items-center bg-background p-6 max-[639px]:p-4 grid min-h-screen place-items-center bg-background p-6">
      <section className="liff-message-card w-full max-w-[440px] rounded-2xl border border-border bg-surface p-8 shadow-overlay max-[639px]:p-5 grid justify-items-start gap-3" role="alert" aria-live="assertive">
        <span className="brand-symbol" aria-hidden="true">LT</span>
        <h1>{heading}</h1>
        <p>{message}</p>
        {/* When a fresh token is what is needed, re-login is the action. A reload
            would re-run the identical exchange against the same stale token. */}
        <button type="button" onClick={onRetry ?? (() => window.location.reload())} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50">
          {onRetry ? "เข้าสู่ระบบด้วย LINE อีกครั้ง" : "ลองใหม่"}
        </button>
        {/* The way out for anyone the LINE button cannot help.
            This card replaces the whole page, so without this a visitor whose
            problem is not LINE — no LINE client, a browser they cannot use it
            in — is left with a retry of the request that just failed. */}
        <p className="text-sm text-muted">
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

/** Thai copy for a throttle, carrying the one number that helps: how long to wait. */
function rateLimitedMessage(retryAfterSeconds: number | null): string {
  const wait = retryAfterSeconds && retryAfterSeconds > 0 ? `ประมาณ ${retryAfterSeconds} วินาที` : "สักครู่";
  return `มีการพยายามเข้าสู่ระบบถี่เกินไป กรุณารอ${wait}แล้วลองใหม่`;
}

/**
 * The screen after the renewal budget is spent.
 *
 * It carries no retry button on purpose: three renewals have already failed, so
 * a fourth attempts the same thing with the user's click as the only variable.
 * The action offered is the way out, plus the email sign-in for anyone who can
 * reach the product without LINE at all.
 */
function LiffTerminalCard() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 max-[639px]:p-4 grid min-h-screen place-items-center bg-background p-6">
      <section className="liff-message-card w-full max-w-[440px] rounded-2xl border border-border bg-surface p-8 shadow-overlay max-[639px]:p-5 grid justify-items-start gap-3" role="alert">
        <span className="brand-symbol" aria-hidden="true">LT</span>
        <h1>LINE ส่งข้อมูลที่ยืนยันไม่ได้ซ้ำ ๆ</h1>
        <p>
          ลองเข้าสู่ระบบใหม่หลายครั้งแล้ว แต่ LINE ยังส่งข้อมูลที่ใช้ยืนยันตัวตนไม่ได้
          ถ้าเครื่องนี้ตั้งเวลาไว้ผิด (นาฬิกาเครื่องคลาดเคลื่อนจากเวลาจริง) ให้แก้เวลาเครื่องแล้วเปิดหน้านี้ใหม่
        </p>
        <button type="button" onClick={closeLiffWindow} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50">
          ปิดหน้านี้
        </button>
        <p className="text-sm text-muted">
          <a href="/login">เข้าสู่ระบบด้วยอีเมลแทน</a>
        </p>
      </section>
    </main>
  );
}

class LiffExchangeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null,
    public readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = "LiffExchangeError";
  }
}

/**
 * Why an exchange failed, as a closed set the UI can act on.
 *
 * The API already tells these apart — `apps/api/src/index.ts:157-193` answers
 * 401 `LIFF_TOKEN_REJECTED` / `LIFF_VERIFICATION_FAILED` for a token LINE will
 * not accept, 429 with `Retry-After` when the caller is being throttled,
 * 502/503 when LINE or the channel config is down, and 403
 * `ACCESS_PENDING` / `ACCESS_NOT_GRANTED` for access. Collapsing all of it into
 * "the status was 401" is what made a throttle look like an expired session and
 * sent the user to a button that re-runs the same failing request.
 *
 * `status` is `0` when no response arrived at all — the fetch itself threw.
 */
export type ExchangeFailure =
  | { kind: "expired" }
  | { kind: "rate_limited"; retryAfterSeconds: number | null }
  | { kind: "server" }
  | { kind: "pending" }
  | { kind: "not_granted" }
  | { kind: "network" }
  | { kind: "other"; status: number };

export function classifyExchangeFailure(input: {
  status?: number | undefined;
  code?: string | null | undefined;
  retryAfterSeconds?: number | null | undefined;
}): ExchangeFailure {
  const status = input.status ?? 0;
  if (status === 0 || input.code === "NETWORK") return { kind: "network" };
  switch (status) {
    case 401:
      // Both codes the API uses here mean "get a new token", not "the server
      // is broken" — the distinction `liffError` exists to preserve.
      return { kind: "expired" };
    case 429:
      return { kind: "rate_limited", retryAfterSeconds: input.retryAfterSeconds ?? null };
    case 502:
    case 503:
      return { kind: "server" };
    case 403:
      if (input.code === "ACCESS_PENDING") return { kind: "pending" };
      if (input.code === "ACCESS_NOT_GRANTED") return { kind: "not_granted" };
      return { kind: "other", status };
    default:
      return { kind: "other", status };
  }
}

/** What the gate does about a failure. `idle` means: show what the API says, act on nothing. */
export type Recovery =
  | "idle"
  | "renew-external"
  | "renew-in-client"
  | "terminal"
  | "pending"
  | "denied"
  | "rate-limited"
  | "error";

/**
 * Three renewals, then stop.
 *
 * A device whose clock runs ahead of LINE's can make every freshly issued token
 * look expired, and "log out, get a new token" then never converges. The bound
 * is what converts that loop into a screen that says so.
 */
export const MAX_RENEW_ATTEMPTS = 3;

/**
 * The recovery decision, pure, with its guards in the order that matters.
 *
 * `signedOut` is checked **first**, before anything that could navigate: an
 * automatic re-authentication after a deliberate sign-out is the defect
 * measured on 2026-11-08 (`ops-verification-2026-11-07-…`), and no recovery
 * branch may reintroduce it.
 *
 * `ungated` is checked next: `/privacy` and `/terms` are legal documents, and a
 * renewal redirect fired while someone is reading one navigates them away from
 * the text they came for. Bypassed paths render, and nothing else.
 */
export function decideRecovery(input: {
  failure: ExchangeFailure;
  attempts: number;
  signedOut: boolean;
  isInClient: boolean;
  ungated: boolean;
}): Recovery {
  if (input.signedOut) return "idle";
  if (input.ungated) return "idle";
  switch (input.failure.kind) {
    case "expired":
      if (input.attempts >= MAX_RENEW_ATTEMPTS) return "terminal";
      // `liff.login()` cannot be used inside a LIFF browser; there the renewal
      // is `logout()` + a reload, which re-runs `liff.init()`.
      return input.isInClient ? "renew-in-client" : "renew-external";
    case "pending":
      return "pending";
    case "not_granted":
      return "denied";
    case "rate_limited":
      return "rate-limited";
    default:
      // server | network | other: retrying a 502 or a dropped connection from
      // the client is noise, and neither is fixed by a new token.
      return "error";
  }
}

/** Turn whatever was thrown into a classified failure. */
export function exchangeFailureOf(error: unknown): ExchangeFailure {
  if (error instanceof LiffExchangeError) {
    return classifyExchangeFailure({
      status: error.status,
      code: error.code,
      retryAfterSeconds: error.retryAfterSeconds
    });
  }
  // Not ours: JSON that was not JSON, an aborted request, a thrown string.
  return { kind: "other", status: 0 };
}

function retryAfterSecondsOf(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Exchange the LINE ID token for a session cookie.
 *
 * Exported for its own test: the renewal budget is cleared here, on success and
 * nowhere else, and "cleared on mount" would make a single bad afternoon
 * permanent by resetting the bound the moment the page loads.
 */
export async function exchangeIdentity(identity: LiffIdentity, signal: AbortSignal): Promise<ExchangeResponse | null> {
  let response: Response;
  try {
    response = await fetch(apiUrl("/api/auth/liff/exchange"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ idToken: identity.idToken }),
      signal
    });
  } catch (error) {
    // No response at all. `status: 0` is the flag classifyExchangeFailure reads
    // as `network`, so a dropped connection cannot be mistaken for a rejection.
    throw new LiffExchangeError(error instanceof Error ? error.message : "network", 0, "NETWORK");
  }
  if (response.status === 403) {
    const data = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    if (data?.error?.code === "ACCESS_PENDING") return null;
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as ApiErrorResponse | null;
    throw new LiffExchangeError(
      data?.error?.message ?? `LINE exchange failed (HTTP ${response.status})`,
      response.status,
      data?.error?.code ?? null,
      retryAfterSecondsOf(response)
    );
  }
  const body = (await response.json()) as ExchangeResponse;
  // A working exchange clears the renewal budget: this browser is demonstrably
  // not stuck, and anything else would make one bad afternoon permanent.
  resetRenewAttempts();
  return body;
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

/**
 * The router can hand back a trailing slash, and two spellings of one path are
 * two facts about the path — which is how a `/login` check comes to pass on one
 * navigation and fail on the next. Every path test in this file goes through
 * here for that reason.
 */
export function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function isUngatedPath(pathname: string): boolean {
  return UNGATED_PATHS.has(normalizePath(pathname));
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
export type GateDecision = "render" | "loading" | "stale" | "error" | "pending" | "terminal" | "denied";

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
  // Both of these are terminal answers about the account or the device, and both
  // outrank `stale`: telling someone their session expired when three renewals
  // have already failed (or their access was revoked) would send them to a
  // button that cannot help.
  if (input.state === "terminal") return "terminal";
  if (input.state === "denied") return "denied";
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

/**
 * Where a browser that just acquired a session should land, or null to leave it
 * where it is.
 *
 * Reported in production on 2026-10-02: pressing "เข้าสู่ระบบด้วย LINE" signed
 * the user in and left them staring at the sign-in form, and a second press was
 * required to reach the dashboard. The cause is a fact about the LINE redirect
 * and not about the exchange.
 *
 * When the SDK has no session yet, the press fires `liff.login()` and the page
 * navigates away. Its `redirectUri` is `window.location.href` — which, on the
 * sign-in page, is `/login`. So LINE returns the user to `/login`, where the gate
 * runs a *fresh* exchange, succeeds, and holds a working session cookie. The
 * only code that navigates to the dashboard after a LINE sign-in lives in the
 * click handler of the page we just navigated away from (`login.tsx`), so it
 * does not run on this page load. The second press works because it is an
 * ordinary click that stays on the page, and its own handler finishes the job.
 *
 * So the exchange was never the thing that failed — the navigation was, and it
 * was dropped on exactly one leg: the leg where LINE redirects. The `exchange`
 * plan had been verified end to end in the real LINE client on 2026-10-01, but
 * that check started from a browser already signed into LINE, where no redirect
 * happens and this code path is never entered. The unreachable leg is the one
 * that was broken.
 *
 * `sessionUsable` is the condition rather than "the exchange just succeeded",
 * so the redirect also covers the reload that follows a successful sign-in
 * (`login.tsx` sends the browser to `/dashboard`, the gate's own effect runs
 * again there) and any later navigation back to `/login` within this page load.
 * Those are the same state — signed in, shown a sign-in form — so they get the
 * same answer rather than a second, subtly different one.
 *
 * Deliberately NOT a redirect for `/privacy` and `/terms`: a signed-in visitor
 * following a link to the privacy policy must stay on the document. Only the
 * sign-in surface sends you away, because only there is the page asking a
 * question the session has already answered.
 */
export function decideAfterSignIn(pathname: string, sessionUsable: boolean): string | null {
  if (!sessionUsable) return null;
  return normalizePath(pathname) === "/login" ? "/dashboard" : null;
}

/**
 * What the gate should do with the LINE session it finds on mount.
 *
 * The defect this encodes was measured in production on 2026-11-08: the gate
 * exchanges a live token on **every** path, so the full page load that
 * `handleSignOut` performs to `/login` minted a new session immediately after
 * the revocations succeeded (`POST /api/auth/liff/exchange` 200 at +0.58 s,
 * `GET /api/me` 200, browser back on `/dashboard`). Sign-out revoked and then
 * the client re-authenticated itself.
 *
 * `signedOut` is checked **before** the expiry branch on purpose. A signed-out
 * browser holds a perfectly good token — that is exactly why it must not be
 * traded for a session — and sending it down the stale path would show the
 * "เซสชัน LINE หมดอายุแล้ว" card, a false statement about a token that has not
 * expired.
 *
 * `isLoggedIn` is part of the decision rather than assumed by the caller so the
 * function is total and the caller's early return cannot be dropped unnoticed.
 */
export type MountExchange = "idle" | "stale" | "exchange";

export function decideMountExchange(input: {
  isLoggedIn: boolean;
  idToken: string | null | undefined;
  signedOut: boolean;
  now?: number;
}): MountExchange {
  if (!input.isLoggedIn) return "idle";
  if (input.signedOut) return "idle";
  return isIdTokenExpired(input.idToken, input.now) ? "stale" : "exchange";
}

/**
 * The same decision, with the marker read here rather than passed in.
 *
 * This exists so the storage→decision seam is testable. It is one line, but it
 * is the line that decides whether a stray `liff_signed_out` value suppresses
 * sign-in: `decideMountExchange` takes `signedOut` as a boolean and cannot see
 * how it was produced, so a widened read (`!== null`, "any truthy value") would
 * pass every test of the pure function while breaking first-time sign-in. The
 * gate calls this and nothing else.
 */
export function decideMountExchangeForThisBrowser(input: {
  isLoggedIn: boolean;
  idToken: string | null | undefined;
  now?: number;
}): MountExchange {
  return decideMountExchange({ ...input, signedOut: isLiffSignedOut() });
}

export function LiffGate({ children }: PropsWithChildren) {
  const [state, setState] = useState<State>("loading");
  const [phase, setPhase] = useState<Phase>("init");
  const [error, setError] = useState<string | null>(null);
  // Our own Thai copy for a failure we can explain precisely (a throttle, with
  // its Retry-After). `error` keeps whatever was thrown and is never rendered.
  const [notice, setNotice] = useState<string | null>(null);
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
    // Assigned once the SDK exists, so the catch block can route an exchange
    // failure through the same decision the happy path uses. Before that point
    // there is nothing to exchange and the init failure keeps its own card.
    let failureHandler: ((failure: ExchangeFailure) => Promise<void>) | null = null;
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
        const action = decideMountExchangeForThisBrowser({ isLoggedIn: true, idToken });
        if (action === "idle") {
          // Signed out deliberately. The API is still asked, because a session
          // created elsewhere (another tab, another press) is the server's fact
          // and not this browser's to assume — but LINE is not asked for a new
          // one, which is the whole point.
          setSessionUsable(await probeSession(controller.signal));
          if (cancelled) return;
          setState("ready");
          return;
        }
        // Every recovery runs through here, so the guards cannot be honoured by
        // one branch and skipped by another: the sign-out marker comes first
        // (an automatic re-auth after a deliberate sign-out is the 2026-11-08
        // defect), then the ungated paths, then the failure kind.
        const handleFailure = async (failure: ExchangeFailure): Promise<void> => {
          const verdict = decideRecovery({
            failure,
            attempts: readRenewAttempts(),
            signedOut: isLiffSignedOut(),
            isInClient: isLiffInClient(),
            ungated: bypass
          });
          if (verdict === "renew-external" || verdict === "renew-in-client") {
            // Counted before navigating, because the page is about to go away.
            bumpRenewAttempts();
            resetLiffLoginGuard();
            try {
              liff.logout();
            } catch {
              // The navigation below does not depend on it.
            }
            if (verdict === "renew-in-client") {
              // `liff.login()` cannot be used inside LINE's browser; a reload
              // re-runs `liff.init()` and lets LINE re-issue the token.
              window.location.reload();
              return;
            }
            liff.login({ redirectUri: window.location.href });
            return;
          }
          setSessionUsable(await probeSession(controller.signal));
          if (cancelled) return;
          if (verdict === "terminal") {
            setState("terminal");
            return;
          }
          if (verdict === "denied") {
            setState("denied");
            return;
          }
          if (verdict === "pending") {
            setPendingAccess(true);
            setState("ready");
            return;
          }
          if (verdict === "rate-limited") {
            setNotice(rateLimitedMessage(failure.kind === "rate_limited" ? failure.retryAfterSeconds : null));
            setState("error");
            return;
          }
          if (verdict === "idle") {
            setState("ready");
            return;
          }
          // server | network | other. The card keeps our Thai copy; the SDK's
          // own wording is never rendered.
          setNotice(null);
          setError(null);
          setState("error");
        };
        failureHandler = handleFailure;

        // Checked BEFORE the exchange. LIFF reports a stale token as a perfectly
        // good one — isLoggedIn() is true and getIDToken() returns it happily —
        // so the API is the only place the expiry surfaces, and its answer is
        // an opaque failure. Classifying it here lets the renew path run without
        // a wasted request that is certain to fail.
        if (action === "stale") {
          await handleFailure({ kind: "expired" });
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
        if (failureHandler) {
          // A failure after the SDK was ready: classify it and let one decision
          // choose. No branch here may sign the user back in after a sign-out,
          // or navigate them off a legal document.
          await failureHandler(exchangeFailureOf(nextError));
          return;
        }
        // The init itself failed. There is no exchange to classify, and the card
        // names the step rather than repeating the SDK's English.
        setSessionUsable(await probeSession(controller.signal));
        if (cancelled) return;
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  // The redirect for a session the LINE redirect just created. It is a full
  // page load rather than a router navigation on purpose: the cookie was set by
  // the exchange response a moment ago, and `_authenticated` resolves the
  // session in `beforeLoad`, so reloading is what makes the new session the one
  // the dashboard is rendered from. It is also the same mechanism the sign-in
  // page already uses, so both sign-in routes end in one place.
  const afterSignIn = decideAfterSignIn(pathname, sessionUsable);
  useEffect(() => {
    if (!afterSignIn) return;
    window.location.replace(afterSignIn);
  }, [afterSignIn]);

  switch (decideGate({ bypass, state, pendingAccess, sessionUsable })) {
    case "render":
      return <>{children}</>;

    case "loading":
      return <main className="grid min-h-screen place-items-center bg-background p-6 max-[639px]:p-4 grid min-h-screen place-items-center bg-background p-6"><section className="liff-message-card w-full max-w-[440px] rounded-2xl border border-border bg-surface p-8 shadow-overlay max-[639px]:p-5 grid justify-items-start gap-3" role="status" aria-live="polite"><span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" /><h1>กำลังตรวจสอบ LINE</h1><p>กำลังเตรียมเซสชันและตรวจสอบสิทธิ์เข้าใช้งาน</p></section></main>;

    case "stale":
      return (
        <LiffGateMessage
          phase="exchange"
          message={staleLiffSessionMessage()}
          onRetry={() => reauthenticateWithLiff(import.meta.env.VITE_LIFF_ID as string)}
        />
      );

    case "error":
      return <LiffGateMessage phase={phase} message={notice ?? liffFailureMessage(phase, error)} />;

    case "terminal":
      // Three renewals have failed. Another button that re-runs the exchange is
      // the loop this exists to end, so the only action is to leave the page.
      return <LiffTerminalCard />;

    case "denied":
      return (
        <main className="grid min-h-screen place-items-center bg-background p-6 max-[639px]:p-4 grid min-h-screen place-items-center bg-background p-6">
          <section className="liff-message-card w-full max-w-[440px] rounded-2xl border border-border bg-surface p-8 shadow-overlay max-[639px]:p-5 grid justify-items-start gap-3" role="alert">
            <span className="brand-symbol" aria-hidden="true">LT</span>
            <h1>บัญชีนี้ไม่ได้รับสิทธิ์เข้าใช้งาน</h1>
            {/* The API's own distinction, kept: ACCESS_NOT_GRANTED is a
                permanent answer about this account, not an expired session, and
                a re-login button here would imply otherwise. */}
            <p>สิทธิ์ของบัญชี LINE นี้ถูกถอนหรือยังไม่ได้รับอนุมัติจากผู้ดูแลระบบ — หากคิดว่าเป็นความผิดพลาด กรุณาติดต่อผู้ดูแลร้าน</p>
            <p className="text-sm text-muted">
              <a href="/login">เข้าสู่ระบบด้วยอีเมลแทน</a>
            </p>
          </section>
        </main>
      );

    case "pending":
      return <main className="grid min-h-screen place-items-center bg-background p-6 max-[639px]:p-4 grid min-h-screen place-items-center bg-background p-6"><section className="liff-message-card w-full max-w-[440px] rounded-2xl border border-border bg-surface p-8 shadow-overlay max-[639px]:p-5 grid justify-items-start gap-3" role="status"><span className="status-pill inline-flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-[11px] font-semibold leading-tight status-pill--warning border-warning/30 bg-warning-soft text-warning-soft-foreground">รอการอนุมัติ</span><h1>ส่งคำขอเข้าใช้งานแล้ว</h1><p>กรุณารอผู้ดูแลระบบอนุมัติสิทธิ์ แล้วเปิดหน้านี้อีกครั้ง</p></section></main>;
  }
}
