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

export async function verifyLiffIdToken(input: {
  idToken: string;
  channelId?: string;
  fetcher?: Fetcher;
}): Promise<VerifiedLineProfile> {
  if (!input.channelId) {
    throw new LiffVerificationError("LINE Login channel ID is not configured", 503);
  }

  const body = new URLSearchParams({ id_token: input.idToken, client_id: input.channelId });
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

  if (!response.ok) {
    throw new LiffVerificationError("LINE identity token is invalid", 401);
  }

  const value = (await response.json()) as { sub?: unknown; name?: unknown };
  if (typeof value.sub !== "string" || typeof value.name !== "string") {
    throw new LiffVerificationError("LINE identity response is incomplete", 401);
  }
  return { userId: value.sub, displayName: value.name };
}
