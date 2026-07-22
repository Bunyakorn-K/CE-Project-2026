export type LiffIdentity = {
  displayName: string;
  userId: string;
  idToken: string;
};

export async function connectLiff(liffId: string): Promise<LiffIdentity | null> {
  const { default: liff } = await import("@line/liff");

  await liff.init({ liffId });
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
