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
    // LINE /oauth2/v2.1/verify returns 400 when client_id does not match the
    // token's aud. That 400 is normalized to 401: a token the API will not
    // accept is the caller's to replace, and reporting LINE's raw status makes
    // an expired token look like a server fault.
    await expect(
      verifyLiffIdToken({
        idToken: "tok",
        channelIds: ["111", "222"],
        fetcher: async () => errorResponse(400)
      })
    ).rejects.toMatchObject({ status: 401 });
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
describe("verifyLiffIdToken (stale browser token)", () => {
  it("reports a rejected token as 401, never as a server fault", async () => {
    // The incident: LINE answered 400 "JWS verification failed" because the
    // browser held a token nine hours past its expiry. Forwarding that 400 (or
    // the 502 the route used to fall back to) tells the operator the server or
    // a gateway is broken, when only the caller's token is stale.
    await expect(
      verifyLiffIdToken({
        idToken: "stale",
        channelIds: ["2011592166"],
        fetcher: async () =>
          new Response(JSON.stringify({ error: "invalid_request", error_description: "JWS verification failed" }), {
            status: 400,
            headers: { "content-type": "application/json" }
          })
      })
    ).rejects.toMatchObject({ status: 401 });
  });

  it("still reports LINE being unreachable as a 502", async () => {
    // The distinction that must survive: unreachable upstream is the server's
    // problem and re-logging the user in would not help.
    await expect(
      verifyLiffIdToken({
        idToken: "tok",
        channelIds: ["2011592166"],
        fetcher: async () => {
          throw new Error("ECONNREFUSED");
        }
      })
    ).rejects.toMatchObject({ status: 502 });
  });
});
