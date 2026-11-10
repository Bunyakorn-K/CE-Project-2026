// Platform-agnostic chat adapter contract. v1 implements the LINE adapter;
// a future Telegram adapter implements the same interface and is registered
// the same way, so the bot core never changes when a platform is added.

export type PlatformName = "line" | "telegram";

/**
 * How a message actually left: a reply costs nothing, a push spends one of the
 * monthly allowance, and "unknown" is an honest third answer for an adapter that
 * cannot say — it must never be recorded as free when it might have cost.
 */
export type DeliveryKind = "reply" | "push" | "unknown";

/** One message in a reply. LINE allows up to five; this chat sends at most two. */
export type OutboundMessage =
  | { kind: "text"; text: string }
  | { kind: "flex"; altText: string; contents: Record<string, unknown> };

/** A tappable suggestion above the keyboard. Free — it rides on the message. */
export type QuickReply = { label: string; text?: string; uri?: string };

export interface PlatformAdapter {
  readonly platform: PlatformName;
  /**
   * Send a text message to a user.
   *
   * `replyToken` is the free path: LINE charges nothing for a reply to a message
   * the user just sent, and the free plan's 300 pushes a month are needed for
   * alerts. The token is short-lived and single-use, so an implementation must
   * fall back to a push when it is missing or rejected.
   */
  sendText(
    userId: string,
    text: string,
    options?: { replyToken?: string; quickReplies?: QuickReply[] }
  ): Promise<DeliveryKind>;
  /**
   * Typing indicator while the model works. Free, and the only signal the user
   * gets between "sent" and "answered" — without it a 6-second tool loop looks
   * like a bot that is broken.
   */
  showLoading?(userId: string, seconds?: number): Promise<void>;
  /**
   * Several messages in one reply. A reply costs one message whether it carries one
   * or five, so a long answer split for readability must not become two sends.
   */
  sendMessages?(
    userId: string,
    messages: OutboundMessage[],
    options?: { replyToken?: string; quickReplies?: QuickReply[] }
  ): Promise<DeliveryKind>;
  /**
   * Push a rich card. Optional because the adapter interface predates cards and
   * a second platform may not have an equivalent: a caller that cannot send one
   * must fall back to `sendText` rather than silently sending nothing.
   */
  sendFlex?(
    userId: string,
    altText: string,
    contents: Record<string, unknown>,
    options?: { replyToken?: string; quickReplies?: QuickReply[] }
  ): Promise<DeliveryKind>;
}
