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

  async sendText(userId: string, text: string): Promise<void> {
    if (!this.client) return;
    await this.client.pushMessage({ to: userId, messages: [{ type: "text", text }] });
  }
}
