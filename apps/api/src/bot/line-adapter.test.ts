import { beforeEach, describe, expect, it, vi } from "vitest";

// The SDK is replaced wholesale: this test is about which API the adapter calls,
// and a real client would need a network and a token to answer that.
const sdk = vi.hoisted(() => ({
  replyMessage: vi.fn(),
  pushMessage: vi.fn()
}));

vi.mock("@line/bot-sdk", () => ({
  messagingApi: {
    MessagingApiClient: class {
      replyMessage = sdk.replyMessage;
      pushMessage = sdk.pushMessage;
    }
  }
}));

const { LineAdapter } = await import("./line-adapter");

beforeEach(() => {
  sdk.replyMessage.mockReset().mockResolvedValue({});
  sdk.pushMessage.mockReset().mockResolvedValue({});
});

describe("LineAdapter.sendText", () => {
  // A reply is free and does not touch the 300-push monthly allowance; a push is
  // charged. The bot answers every AI question, so this is the difference between
  // a working alert budget and none.
  it("replies with the token when it has one, and does not push", async () => {
    const adapter = new LineAdapter("token");
    await adapter.sendText("U-1", "hello", { replyToken: "rt-1" });

    expect(sdk.replyMessage).toHaveBeenCalledTimes(1);
    expect(sdk.replyMessage.mock.calls[0][0]).toMatchObject({
      replyToken: "rt-1",
      messages: [{ type: "text", text: "hello" }]
    });
    expect(sdk.pushMessage).not.toHaveBeenCalled();
  });

  it("falls back to a push when the reply token is rejected", async () => {
    // Reply tokens expire in about a minute and are single-use; the LLM loop can
    // outlast that, and losing the answer would be worse than spending a message.
    sdk.replyMessage.mockRejectedValueOnce(new Error("Invalid reply token"));
    const adapter = new LineAdapter("token");

    await adapter.sendText("U-1", "hello", { replyToken: "rt-expired" });

    expect(sdk.pushMessage).toHaveBeenCalledTimes(1);
    expect(sdk.pushMessage.mock.calls[0][0]).toMatchObject({ to: "U-1" });
  });

  it("pushes when there is no token at all", async () => {
    const adapter = new LineAdapter("token");
    await adapter.sendText("U-1", "hello");
    expect(sdk.replyMessage).not.toHaveBeenCalled();
    expect(sdk.pushMessage).toHaveBeenCalledTimes(1);
  });

  it("is a no-op without a channel access token, so the webhook still acks", async () => {
    const adapter = new LineAdapter(undefined);
    await adapter.sendText("U-1", "hello", { replyToken: "rt-1" });
    expect(sdk.replyMessage).not.toHaveBeenCalled();
    expect(sdk.pushMessage).not.toHaveBeenCalled();
  });
});

describe("LineAdapter.sendFlex", () => {
  it("pushes a card with altText capped at LINE's 400 characters", async () => {
    const adapter = new LineAdapter("token");
    await adapter.sendFlex("U-1", "x".repeat(500), { type: "bubble" });

    const message = sdk.pushMessage.mock.calls[0][0].messages[0];
    expect(message.type).toBe("flex");
    expect(message.altText.length).toBe(400);
    expect(message.contents).toEqual({ type: "bubble" });
  });
});
