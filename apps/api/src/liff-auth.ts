type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type VerifiedLineProfile = {
  userId: string;
  displayName: string;
};

export class LiffVerificationError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "LiffVerificationError";
  }
}

export function parseChannelIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

export async function verifyLiffIdToken(input: {
  idToken: string;
  /** Single channel (legacy LINE Login / LIFF). Mutually exclusive with channelIds. */
  channelId?: string;
  /** Accepted audience channel ids (LINE MINI App internal channels: developing/review/published). */
  channelIds?: string[];
  fetcher?: Fetcher;
}): Promise<VerifiedLineProfile> {
  const channels = input.channelIds?.length ? input.channelIds : input.channelId ? [input.channelId] : [];
  if (channels.length === 0) {
    throw new LiffVerificationError("LINE Login channel ID is not configured", 503);
  }

  let lastError: Response | null = null;
  for (const channelId of channels) {
    const body = new URLSearchParams({ id_token: input.idToken, client_id: channelId });
    let response: Response;
    try {
      response = await (input.fetcher ?? fetch)("https://api.line.me/oauth2/v2.1/verify", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body
      });
    } catch {
      throw new LiffVerificationError("LINE identity verification is unavailable", 502);
    }

    if (response.ok) {
      const value = (await response.json()) as { sub?: unknown; name?: unknown };
      if (typeof value.sub !== "string" || typeof value.name !== "string") {
        throw new LiffVerificationError("LINE identity response is incomplete", 401);
      }
      return { userId: value.sub, displayName: value.name };
    }
    lastError = response;
  }

  /**
   * Every channel rejected the token, so the token itself is the problem.
   *
   * The status is **401**, deliberately not LINE's own 400. LINE answers an
   * expired token, a token signed for another channel, and a malformed one
   * identically — all three are the caller's to fix, by fetching a new token.
   * Forwarding 400 (or collapsing everything into the 502 this path used to
   * fall through to) tells the operator the server or a gateway is broken,
   * which is not true, and leaves the browser's retry button re-running the
   * same failing exchange forever.
   *
   * Only two conditions are genuinely the server's fault, and they stay
   * distinct above: LINE unreachable (502) and no channel id configured (503).
   */
  throw new LiffVerificationError("LINE identity token is invalid", 401);
}
