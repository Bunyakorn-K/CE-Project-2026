import { validateSignature } from "@line/bot-sdk";

const channelSecret = process.env.LINE_CHANNEL_SECRET;

export function isValidLineSignature(body: string, signature: string | undefined) {
  return Boolean(channelSecret && signature && validateSignature(body, channelSecret, signature));
}
