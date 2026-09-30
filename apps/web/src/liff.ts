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
