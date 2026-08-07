import { messagingApi, validateSignature, type WebhookEvent } from "@line/bot-sdk";

const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const client = accessToken
  ? new messagingApi.MessagingApiClient({ channelAccessToken: accessToken })
  : null;

export function isValidLineSignature(body: string, signature: string | undefined) {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  return Boolean(channelSecret && signature && validateSignature(body, channelSecret, signature));
}

export async function replyToLineEvent(event: WebhookEvent) {
  if (!client || event.type !== "message" || event.message.type !== "text") {
    return;
  }

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [
      {
        type: "text",
        text: "LaundryTwin received your message. Connect the production command service before enabling operational actions."
      }
    ]
  });
}
