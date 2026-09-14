import { describe, expect, it } from "vitest";
import { verifyLiffIdToken } from "./liff-auth";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function errorResponse(status: number): Response {
  return new Response("{}", { status });
}

describe("verifyLiffIdToken (LINE MINI App multi-channel)", () => {
  it("accepts a token whose client_id matches an allowed channel id", async () => {
    let calledWith = "";
    const profile = await verifyLiffIdToken({
      idToken: "tok",
      channelIds: ["111", "222", "333"],
      fetcher: async (_input, init) => {
        calledWith = new URLSearchParams(String(init?.body)).get("client_id") ?? "";
        if (calledWith === "222") return okResponse({ sub: "u_chiangmai", name: "Chiang Mai Owner" });
        return errorResponse(400);
      }
    });
    expect(calledWith).toBe("222");
    expect(profile).toEqual({ userId: "u_chiangmai", displayName: "Chiang Mai Owner" });
  });

  it("rejects when no channel id matches", async () => {
    // LINE /oauth2/v2.1/verify returns 400 when client_id does not match the token's aud.
    await expect(
      verifyLiffIdToken({
        idToken: "tok",
        channelIds: ["111", "222"],
        fetcher: async () => errorResponse(400)
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("still supports the single channelId form", async () => {
    const profile = await verifyLiffIdToken({
      idToken: "tok",
      channelId: "abc",
      fetcher: async () => okResponse({ sub: "u_old", name: "Old" })
    });
    expect(profile.userId).toBe("u_old");
  });

  it("throws 503 when no channels are configured", async () => {
    await expect(verifyLiffIdToken({ idToken: "tok" })).rejects.toMatchObject({ status: 503 });
  });
});