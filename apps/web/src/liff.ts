export type LiffIdentity = {
  displayName: string;
  userId: string;
  idToken: string;
};

// LIFF SDK must be initialized exactly once per page. Re-initializing can
// reset the login state, so memoize the (successful or failed) result.
let liffInstance: typeof import("@line/liff")["default"] | null | undefined;
// The last error thrown by liff.init(). Kept so a gate can surface the real
// reason the SDK failed instead of silently treating it as "no LINE context"
// — which is indistinguishable from a broken channel config or a rejected
// token exchange. See docs/02_architecture for the loop this caused.
let initError: Error | null = null;

/**
 * Initialize LIFF.
 *
 * Returns the SDK instance on success. Returns null when the SDK is genuinely
 * unavailable — a plain browser outside the LINE client. The distinction
 * matters: `liff.init()` inside LINE calls `liff.login()` itself and then
 * throws INIT_FAILED, which is NOT "no LINE context" and must not be retried
 * blindly. Callers that need to distinguish should read `getLiffInitError()`.
 */
export async function initLiff(liffId: string): Promise<typeof import("@line/liff")["default"] | null> {
  if (liffInstance !== undefined) return liffInstance;
  try {
    const { default: liff } = await import("@line/liff");
    await liff.init({ liffId });
    liffInstance = liff;
    initError = null;
    return liff;
  } catch (err) {
    // Keep the reason: the SDK throws a LIFF error (code + message) that says
    // exactly what LINE rejected. Discarding it made every failure look
    // identical to "desktop browser".
    initError = err instanceof Error ? err : new Error(String(err));
    liffInstance = null;
    return null;
  }
}

/** The error from the last liff.init(), or null when it never threw. */
export function getLiffInitError(): Error | null {
  return initError;
}

// The root LiffGate owns the liff.login() call at boot (once, with a
// redirectUri). Nothing else should fire login() — a second call while a
// LINE redirect is in flight is what loops the page.
const LOGIN_SENT_KEY = "liff_login_sent";
const LOGIN_SENT_AT_KEY = "liff_login_sent_at";
// Cap how long we consider a sent login still "in flight". The LINE redirect
// normally returns in seconds; if it is older than this we assume it failed
// (user cancelled, SDK error) instead of blocking a retry forever.
const LOGIN_SENT_MAX_AGE_MS = 5 * 60 * 1000;

export function loginSentRecently(): boolean {
  if (typeof localStorage === "undefined") return false;
  const flag = localStorage.getItem(LOGIN_SENT_KEY);
  if (!flag) return false;
  const sentAt = Number(localStorage.getItem(LOGIN_SENT_AT_KEY) ?? 0);
  if (!sentAt || Date.now() - sentAt > LOGIN_SENT_MAX_AGE_MS) return false;
  return true;
}

/** Manual "Sign in with LINE" press: fire login() once, guarded. */
export function manualLiffLogin(liffId: string): void {
  if (loginSentRecently()) return;
  void (async () => {
    const liff = await initLiff(liffId);
    if (!liff || liff.isLoggedIn()) return;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LOGIN_SENT_KEY, "1");
      localStorage.setItem(LOGIN_SENT_AT_KEY, String(Date.now()));
    }
    liff.login({ redirectUri: window.location.href });
  })();
}

/**
 * Why `getIDToken()` came back empty.
 *
 * An ID token is only issued when the LIFF app has the `openid` scope selected
 * in the LINE Developers Console (LIFF tab) and the user granted it. A LIFF app
 * without that scope is otherwise perfectly healthy: `isLoggedIn()` is true and
 * `getProfile()` works, so the failure shows up only at the ID token and reads
 * like a broken backend. The two causes need different fixes — one is a console
 * setting, the other is the user re-consenting — so they must not share a
 * message.
 *
 * `appScopes` is `liff.getContext()` (what the LIFF app is configured with) and
 * `grantedScopes` is `liff.permission.getGrantedAll()` (what this user agreed
 * to). `null` means "could not read", which is different from "not present".
 */
export function missingIdTokenMessage(input: {
  appScopes: readonly string[] | null;
  grantedScopes: readonly string[] | null;
}): string {
  if (input.appScopes !== null && !input.appScopes.includes("openid")) {
    return "แอป LINE LIFF ยังไม่ได้เปิดสิทธิ์ openid — เจ้าของช่องต้องเปิดสิทธิ์นี้ใน LINE Developers Console แท็บ LIFF แล้วผู้ใช้เปิดแอปใหม่";
  }
  if (input.grantedScopes !== null && !input.grantedScopes.includes("openid")) {
    return "ผู้ใช้ยังไม่ได้อนุญาตสิทธิ์ openid — ให้ออกจากระบบแล้วเข้า LINE ใหม่ เพื่อให้แสดงหน้าขออนุญาตอีกครั้ง";
  }
  return "LINE ไม่ได้ส่ง ID token มาให้แอปนี้ — ตรวจสอบว่าแอป LINE LIFF เปิดสิทธิ์ openid แล้ว และผู้ใช้ได้อนุญาต";
}

/**
 * Read the two scope lists without letting a failure here mask the real one.
 * LIFF throws rather than returning an empty list when it cannot answer, and an
 * empty list would be read as "the scope is missing" — the one conclusion this
 * function must not reach on no evidence.
 */
export async function missingIdTokenReason(
  liff: typeof import("@line/liff")["default"]
): Promise<string> {
  const [appScopes, grantedScopes] = await Promise.all([
    readScopes(() => liff.getContext()),
    readScopes(() => liff.permission.getGrantedAll())
  ]);
  return missingIdTokenMessage({ appScopes, grantedScopes });
}

async function readScopes(read: () => unknown): Promise<string[] | null> {
  try {
    const value = read();
    return Array.isArray(value) ? (value as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * The `exp` claim of an ID token, as milliseconds, or null when it cannot be read.
 *
 * This exists because a STALE token is a distinct failure from a MISSING one,
 * and the LIFF SDK does not tell them apart: `isLoggedIn()` stays true and
 * `getIDToken()` keeps handing back the same expired token (observed
 * 2026-10-01, a token 9 hours past its 60-minute life, still returned twice in
 * a row). Sending that to the API produced an opaque 502 and a "try again"
 * button that re-ran the identical failing exchange forever.
 *
 * The payload is decoded but NOT verified — this only decides what the user is
 * told and whether to re-login. The signature is the server's job and remains
 * so; trusting a client-side `exp` for anything but presentation would be
 * exactly the "fabricate data" failure the project rules forbid.
 */
export function idTokenExpiryMs(idToken: string | null | undefined): number | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(withPadding);
  // JWT payloads are UTF-8; the Thai display name in `name` is multi-byte, and
  // treating those bytes as Latin-1 would corrupt it.
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Treat a token as expired slightly early, so it cannot die in flight. */
const ID_TOKEN_EXPIRY_SKEW_MS = 30 * 1000;

export function isIdTokenExpired(
  idToken: string | null | undefined,
  now: number = Date.now()
): boolean {
  const expiry = idTokenExpiryMs(idToken);
  // An unreadable `exp` is NOT an expiry. Guessing "expired" here would send a
  // user through a pointless re-login for a token that may be perfectly valid.
  return expiry !== null && expiry - ID_TOKEN_EXPIRY_SKEW_MS <= now;
}

/**
 * What to tell someone whose LINE session went stale, and what to do about it.
 *
 * The fix is a fresh login, not a retry — so the UI has to offer one. Telling
 * them to reload is what made this look like an unrecoverable outage.
 */
export function staleLiffSessionMessage(): string {
  return "เซสชัน LINE หมดอายุแล้ว — กรุณาเข้าสู่ระบบด้วย LINE อีกครั้งเพื่อรับสิทธิ์เข้าใช้งานใหม่";
}

/**
 * What a "sign in with LINE" press has to do, given the session it finds.
 *
 * The three cases are genuinely different and collapsing any two of them breaks
 * sign-in for real users:
 *
 * - `login` — no session. Fire `liff.login()`. The ordinary first visit.
 * - `exchange` — a session with a live token. Trade it for a session cookie.
 *   This is the common case for anyone already signed in to LINE, and it must
 *   NOT log them out: discarding a valid session and returning early is what
 *   made the button do nothing at all (fixed 2026-10-01).
 * - `renew` — a session whose token is expired. `logout()` first, or the SDK
 *   replays the same dead token and the press loops forever.
 *
 * Kept pure and separate from the SDK so the decision can be tested without a
 * LINE client, which is the only reason this bug reached production.
 */
export type LineSignInPlan = "login" | "exchange" | "renew";

export function planLineSignIn(input: {
  isLoggedIn: boolean;
  idToken: string | null | undefined;
  now?: number;
}): LineSignInPlan {
  if (!input.isLoggedIn) return "login";
  // An unreadable or absent token is NOT an expiry — it stays unknown, and the
  // exchange reports the real reason (missing openid scope, or no consent).
  return isIdTokenExpired(input.idToken, input.now) ? "renew" : "exchange";
}

/** `getIDToken()` reads a cache and can reject; a failure here is "unknown". */
async function readIdToken(liff: typeof import("@line/liff")["default"]): Promise<string | null> {
  try {
    return await liff.getIDToken();
  } catch {
    return null;
  }
}

/**
 * One sign-in path, shared by the login button and the stale-session card.
 *
 * Both call sites previously carried their own copy of this logic and the login
 * page's had no test at all, which is how a button that could not sign anyone in
 * shipped. Returns the identity to exchange, or null when `liff.login()` has
 * been fired and the SDK is navigating away — in which case the caller must not
 * continue.
 */
export async function signInWithLiff(liffId: string): Promise<LiffIdentity | null> {
  const liff = await initLiff(liffId);

  if (!liff?.isLoggedIn()) {
    manualLiffLogin(liffId);
    return null;
  }

  const plan = planLineSignIn({ isLoggedIn: true, idToken: await readIdToken(liff) });
  if (plan === "renew") {
    // `logout()` is documented as clearing the session and returning nothing;
    // it is NOT documented to navigate, so nothing here may assume the page is
    // about to go away. Clear the one-shot login guard so the login fired below
    // is not swallowed by the guard left over from the press that got here.
    liff.logout();
    resetLiffLoginGuard();
    manualLiffLogin(liffId);
    return null;
  }

  return connectLiff(liffId);
}

export async function connectLiff(liffId: string): Promise<LiffIdentity | null> {
  const liff = await initLiff(liffId);
  if (!liff) return null;

  // The root LiffGate owns the single liff.login() call at boot. This helper
  // only performs the exchange; if there is no LINE session yet it returns
  // null so the caller can render the sign-in button instead of re-firing
  // login() (which would loop against the redirect).
  if (!liff.isLoggedIn()) {
    return null;
  }

  const [profile, idToken] = await Promise.all([liff.getProfile(), liff.getIDToken()]);
  if (!idToken) {
    throw new Error(await missingIdTokenReason(liff));
  }

  return {
    displayName: profile.displayName,
    userId: profile.userId,
    idToken
  };
}

/** Clear the one-shot guard so a manual "Sign in with LINE" press can retry. */
export function resetLiffLoginGuard() {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LOGIN_SENT_KEY);
  localStorage.removeItem(LOGIN_SENT_AT_KEY);
}
