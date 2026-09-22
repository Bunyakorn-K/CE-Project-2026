export type LiffIdentity = {
  displayName: string;
  userId: string;
  idToken: string;
};

// LIFF SDK must be initialized exactly once per page. Re-initializing can
// reset the login state, so memoize the (successful or failed) result.
let liffInstance: typeof import("@line/liff")["default"] | null | undefined;

/** Initialize LIFF silently. Returns null when outside a LINE context (browser). */
export async function initLiff(liffId: string): Promise<typeof import("@line/liff")["default"] | null> {
  if (liffInstance !== undefined) return liffInstance;
  try {
    const { default: liff } = await import("@line/liff");
    await liff.init({ liffId });
    liffInstance = liff;
    return liff;
  } catch {
    // LIFF is only available inside LINE (mini app webview or LINE in-app browser).
    // In a regular browser the SDK throws — treat it as "no LINE context".
    liffInstance = null;
    return null;
  }
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
    throw new Error("LINE did not provide an ID token for this LIFF app");
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
