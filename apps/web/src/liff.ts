export type LiffIdentity = {
  displayName: string;
  userId: string;
  idToken: string;
};

/** Initialize LIFF silently. Returns null when outside a LINE context (browser). */
export async function initLiff(liffId: string): Promise<typeof import("@line/liff")["default"] | null> {
  try {
    const { default: liff } = await import("@line/liff");
    await liff.init({ liffId });
    return liff;
  } catch {
    // LIFF is only available inside LINE (mini app webview or LINE in-app browser).
    // In a regular browser the SDK throws — treat it as "no LINE context".
    return null;
  }
}

export async function connectLiff(liffId: string): Promise<LiffIdentity | null> {
  const liff = await initLiff(liffId);
  if (!liff) return null;

  if (!liff.isLoggedIn()) {
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
