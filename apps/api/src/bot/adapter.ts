// Platform-agnostic chat adapter contract. v1 implements the LINE adapter;
// a future Telegram adapter implements the same interface and is registered
// the same way, so the bot core never changes when a platform is added.

export type PlatformName = "line" | "telegram";

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
  sendText(userId: string, text: string, options?: { replyToken?: string }): Promise<void>;
  /**
   * Push a rich card. Optional because the adapter interface predates cards and
   * a second platform may not have an equivalent: a caller that cannot send one
   * must fall back to `sendText` rather than silently sending nothing.
   */
  sendFlex?(userId: string, altText: string, contents: Record<string, unknown>): Promise<void>;
}
