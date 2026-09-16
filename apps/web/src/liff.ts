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

const LOGIN_SENT_KEY = "liff_login_sent";

export async function connectLiff(liffId: string): Promise<LiffIdentity | null> {
  const liff = await initLiff(liffId);
  if (!liff) return null;

  if (!liff.isLoggedIn()) {
    // Only send the user to LINE once per browser session. If the redirect
    // comes back still without a LINE session (user cancelled, SDK issue),
    // returning null here breaks the login-redirect loop instead of
    // re-firing liff.login() on every page load.
    if (typeof sessionStorage !== "undefined" && sessionStorage.getItem(LOGIN_SENT_KEY)) {
      return null;
    }
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(LOGIN_SENT_KEY, "1");
    liff.login();
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
  if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(LOGIN_SENT_KEY);
}
