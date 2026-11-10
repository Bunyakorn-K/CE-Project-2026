import { messagingApi } from "@line/bot-sdk";
import type { PlatformAdapter } from "./adapter";

export class LineAdapter implements PlatformAdapter {
  readonly platform = "line" as const;
  private client: messagingApi.MessagingApiClient | null;

  constructor(channelAccessToken: string | undefined) {
    // Without a token the adapter is a silent no-op; the webhook still acks so
    // LINE never retries a message the deployment is not configured to answer.
    this.client = channelAccessToken
      ? new messagingApi.MessagingApiClient({ channelAccessToken })
      : null;
  }

  async sendText(userId: string, text: string, options: { replyToken?: string } = {}): Promise<void> {
    if (!this.client) return;
    const messages = [{ type: "text" as const, text }];

    // A reply is free and does not touch the monthly push allowance; a push is
    // charged. The token expires about a minute after the user's message and can
    // only be used once, so a rejected reply falls back rather than losing the
    // answer — the LLM loop can outlast the window.
    if (options.replyToken) {
      try {
        await this.client.replyMessage({ replyToken: options.replyToken, messages });
        return;
      } catch {
        // fall through to push
      }
    }
    await this.client.pushMessage({ to: userId, messages });
  }

  /**
   * `altText` is what LINE shows in the notification banner, on the lock screen
   * and in clients that cannot render a flex message — so it is required, and
   * LINE rejects anything over 400 characters.
   */
  async sendFlex(userId: string, altText: string, contents: Record<string, unknown>): Promise<void> {
    if (!this.client) return;
    await this.client.pushMessage({
      to: userId,
      messages: [
        {
          type: "flex",
          altText: altText.slice(0, 400),
          contents: contents as messagingApi.FlexContainer
        }
      ]
    });
  }
}
