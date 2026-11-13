// Who is this LINE user, in LINE's own words?
//
// The webhook's `source` carries a userId and nothing else — `displayName` exists on
// the LIFF *profile*, not on the message event, so `event.source?.displayName` is
// always undefined. The bot's fallback therefore had to invent a name, and every
// access request in the admin list read "LINE bot user" no matter who asked. An
// operator approving a stranger cannot tell two requests apart, and the account that
// approval creates is named after the bot forever.
//
// The Messaging API can answer this — the user messaged the bot, so a 1:1 profile is
// available. It is best-effort and time-boxed: naming the requester is worth a couple
// hundred milliseconds, never a stalled webhook (LINE retries an unanswered one).

import { messagingApi } from "@line/bot-sdk";

export type ProfileLookup = (lineUserId: string) => Promise<string | null>;

const DEFAULT_TIMEOUT_MS = 2500;

/**
 * A display-name lookup backed by the Messaging API.
 *
 * Returns `null` rather than throwing on any failure — no token, a timeout, a revoked
 * account, LINE down. Callers keep their own fallback; a refusal to answer a request
 * must not depend on this succeeding.
 */
export function lineProfileLookup(
  channelAccessToken: string | undefined,
  options: { timeoutMs?: number; client?: Pick<messagingApi.MessagingApiClient, "getProfile"> } = {}
): ProfileLookup {
  if (!channelAccessToken && !options.client) return async () => null;
  const client = options.client ?? new messagingApi.MessagingApiClient({ channelAccessToken: channelAccessToken! });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (lineUserId: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const profile = await Promise.race([
        client.getProfile(lineUserId),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        })
      ]);
      const name = profile?.displayName?.trim();
      return name ? name : null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/** The name to store when LINE could not tell us one. */
export const UNKNOWN_PERSON = "ไม่ทราบชื่อ (LINE)";

/** Names that describe the bot or nobody, and therefore should be repaired. */
export function isPlaceholderName(name: string | null | undefined): boolean {
  const trimmed = (name ?? "").trim();
  return trimmed === "" || trimmed === UNKNOWN_PERSON || trimmed === "LINE bot user";
}
