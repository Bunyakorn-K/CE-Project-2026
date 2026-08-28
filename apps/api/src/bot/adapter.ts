// Platform-agnostic chat adapter contract. v1 implements the LINE adapter;
// a future Telegram adapter implements the same interface and is registered
// the same way, so the bot core never changes when a platform is added.

export type PlatformName = "line" | "telegram";

export interface PlatformAdapter {
  readonly platform: PlatformName;
  /** Push a text message to a user identified by the platform's userId. */
  sendText(userId: string, text: string): Promise<void>;
}
