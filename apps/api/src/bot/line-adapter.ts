import { messagingApi } from "@line/bot-sdk";
import type { DeliveryKind, OutboundMessage, PlatformAdapter, QuickReply } from "./adapter";

const MAX_QUICK_REPLIES = 13;

/** LINE's quick reply: max 13 items, labels are capped at 20 characters. */
function quickReplyObject(items: QuickReply[] | undefined) {
  if (!items || items.length === 0) return undefined;
  return {
    items: items.slice(0, MAX_QUICK_REPLIES).map((item) => ({
      type: "action" as const,
      action: item.data
        ? { type: "postback" as const, label: item.label.slice(0, 20), data: item.data, displayText: item.label }
        : item.uri
          ? { type: "uri" as const, label: item.label.slice(0, 20), uri: item.uri }
          : { type: "message" as const, label: item.label.slice(0, 20), text: item.text ?? item.label }
    }))
  };
}

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

  async sendText(
    userId: string,
    text: string,
    options: { replyToken?: string; quickReplies?: QuickReply[] } = {}
  ): Promise<DeliveryKind> {
    if (!this.client) return "unknown";
    const quickReply = quickReplyObject(options.quickReplies);
    const messages = [{ type: "text" as const, text, ...(quickReply ? { quickReply } : {}) }];

    // A reply is free and does not touch the monthly push allowance; a push is
    // charged. The token expires about a minute after the user's message and can
    // only be used once, so a rejected reply falls back rather than losing the
    // answer — the LLM loop can outlast the window.
    if (options.replyToken) {
      try {
        await this.client.replyMessage({ replyToken: options.replyToken, messages });
        return "reply";
      } catch {
        // fall through to push
      }
    }
    await this.client.pushMessage({ to: userId, messages });
    return "push";
  }

  /** One reply carrying every part: a reply is charged once, not once per part. */
  async sendMessages(
    userId: string,
    messages: OutboundMessage[],
    options: { replyToken?: string; quickReplies?: QuickReply[] } = {}
  ): Promise<DeliveryKind> {
    if (!this.client) return "unknown";
    const quickReply = quickReplyObject(options.quickReplies);
    const payload = messages.map((message) =>
      message.kind === "flex"
        ? {
            type: "flex" as const,
            altText: message.altText.slice(0, 400),
            contents: message.contents as messagingApi.FlexContainer,
            ...(quickReply ? { quickReply } : {})
          }
        : { type: "text" as const, text: message.text, ...(quickReply ? { quickReply } : {}) }
    );

    if (options.replyToken) {
      try {
        await this.client.replyMessage({ replyToken: options.replyToken, messages: payload });
        return "reply";
      } catch {
        // fall through to push
      }
    }
    await this.client.pushMessage({ to: userId, messages: payload });
    return "push";
  }

  /** Best effort: a failed indicator must never fail the answer. */
  async showLoading(userId: string, seconds = 20): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.showLoadingAnimation({ chatId: userId, loadingSeconds: seconds });
    } catch {
      // cosmetic only
    }
  }

  /**
   * `altText` is what LINE shows in the notification banner, on the lock screen
   * and in clients that cannot render a flex message — so it is required, and
   * LINE rejects anything over 400 characters.
   */
  async sendFlex(
    userId: string,
    altText: string,
    contents: Record<string, unknown>,
    options: { replyToken?: string; quickReplies?: QuickReply[] } = {}
  ): Promise<DeliveryKind> {
    if (!this.client) return "unknown";
    const quickReply = quickReplyObject(options.quickReplies);
    const messages = [
      {
        type: "flex" as const,
        altText: altText.slice(0, 400),
        contents: contents as messagingApi.FlexContainer,
        ...(quickReply ? { quickReply } : {})
      }
    ];

    // A card is still a message: sent as a reply it costs nothing, sent as a push
    // it spends one of the 300. The alert path has no token so it always pushes;
    // the chat path replies whenever the token is still alive.
    if (options.replyToken) {
      try {
        await this.client.replyMessage({ replyToken: options.replyToken, messages });
        return "reply";
      } catch {
        // fall through to push
      }
    }
    await this.client.pushMessage({ to: userId, messages });
    return "push";
  }
}
