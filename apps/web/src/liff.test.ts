import { describe, expect, it } from "vitest";
import { idTokenExpiryMs, isIdTokenExpired, missingIdTokenMessage, planLineSignIn, staleLiffSessionMessage } from "./liff";

describe("missingIdTokenMessage", () => {
  it("blames the console when the LIFF app has no openid scope", () => {
    // The reported case: login works, the profile resolves, and only the ID
    // token is missing because the app was never given the scope.
    const message = missingIdTokenMessage({ appScopes: ["profile"], grantedScopes: ["profile"] });
    expect(message).toContain("LINE Developers Console");
    expect(message).toContain("openid");
  });

  it("blames consent when the app has openid but the user has not granted it", () => {
    const message = missingIdTokenMessage({ appScopes: ["profile", "openid"], grantedScopes: ["profile"] });
    expect(message).toContain("ยังไม่ได้อนุญาต");
    expect(message).not.toContain("LINE Developers Console");
  });

  it("keeps the console message when both the scope and the consent are absent", () => {
    // App scope first: the console fix is the one that has to happen before a
    // consent prompt can even exist.
    expect(missingIdTokenMessage({ appScopes: [], grantedScopes: [] })).toContain("LINE Developers Console");
  });

  it("does not conclude the scope is missing when the scopes could not be read", () => {
    // null means "LIFF threw", not "the list was empty". Reading it as empty
    // would send the operator to the console for a setting that is already set.
    const message = missingIdTokenMessage({ appScopes: null, grantedScopes: null });
    expect(message).not.toContain("LINE Developers Console");
    expect(message).toContain("ตรวจสอบ");
  });

  it("still says the scope to check when only the granted list is readable", () => {
    const message = missingIdTokenMessage({ appScopes: null, grantedScopes: [] });
    expect(message).toContain("ยังไม่ได้อนุญาต");
  });
});
describe("idTokenExpiryMs", () => {
  // A real ID token payload from the incident, with only `exp` meaningful here.
  function token(payload: Record<string, unknown>): string {
    const encode = (v: unknown) =>
      btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(v))))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${encode({ alg: "RS256" })}.${encode(payload)}.sig`;
  }

  it("reads exp as milliseconds", () => {
    expect(idTokenExpiryMs(token({ exp: 1790794078 }))).toBe(1790794078000);
  });

  it("returns null rather than guessing when the token cannot be read", () => {
    // A wrong guess here is what would send a valid user through a pointless
    // re-login, so every unreadable shape must be null and not "expired".
    expect(idTokenExpiryMs(null)).toBeNull();
    expect(idTokenExpiryMs(undefined)).toBeNull();
    expect(idTokenExpiryMs("")).toBeNull();
    expect(idTokenExpiryMs("not-a-jwt")).toBeNull();
    expect(idTokenExpiryMs("only.two")).toBeNull();
    expect(idTokenExpiryMs(`a.${btoa("{not json")}`)).toBeNull();
    expect(idTokenExpiryMs(token({ exp: "soon" }))).toBeNull();
  });

  it("decodes a multi-byte name without corrupting it", () => {
    const thai = token({ exp: 1790794078, name: "ผู้ดูแลร้าน" });
    expect(idTokenExpiryMs(thai)).toBe(1790794078000);
  });
});

describe("isIdTokenExpired", () => {
  function tokenWithExp(expSeconds: number): string {
    const payload = btoa(JSON.stringify({ exp: expSeconds }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `a.${payload}.sig`;
  }

  it("treats the incident's token as expired", () => {
    // exp 2026-09-30T18:47:58Z, observed at 2026-10-01T03:52Z — nine hours past
    // a sixty-minute life. This is the token that dead-ended the login.
    const stale = tokenWithExp(1790794078);
    expect(isIdTokenExpired(stale, Date.parse("2026-10-01T03:52:00Z"))).toBe(true);
  });

  it("treats a live token as valid", () => {
    const live = tokenWithExp(1790794078);
    expect(isIdTokenExpired(live, Date.parse("2026-09-30T18:00:00Z"))).toBe(false);
  });

  it("expires slightly early so a token cannot die mid-flight", () => {
    const token = tokenWithExp(Math.floor(Date.parse("2026-10-01T00:00:20Z") / 1000));
    expect(isIdTokenExpired(token, Date.parse("2026-10-01T00:00:00Z"))).toBe(true);
  });

  it("does NOT call an unreadable token expired", () => {
    // The dangerous direction: guessing "expired" re-logs-in a user whose token
    // was fine. Unknown must stay unknown.
    expect(isIdTokenExpired("garbage", Date.now())).toBe(false);
    expect(isIdTokenExpired(null, Date.now())).toBe(false);
  });
});

describe("staleLiffSessionMessage", () => {
  it("offers a re-login rather than a retry, and says so in Thai", () => {
    const message = staleLiffSessionMessage();
    expect(message).toContain("หมดอายุ");
    expect(message).toContain("เข้าสู่ระบบ");
  });
});

describe("planLineSignIn", () => {
  function tokenWithExp(expSeconds: number): string {
    const payload = btoa(JSON.stringify({ exp: expSeconds }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `a.${payload}.sig`;
  }

  const NOW = Date.parse("2026-10-01T04:00:00Z");
  const LIVE = tokenWithExp(Math.floor((NOW + 60 * 60 * 1000) / 1000));
  const DEAD = tokenWithExp(Math.floor((NOW - 9 * 60 * 60 * 1000) / 1000));

  it("exchanges a LIVE token instead of logging the user out", () => {
    // THE REGRESSION. Shipped 2026-10-01: the login button called logout() for
    // any logged-in session and returned, so pressing it destroyed a perfectly
    // valid session and exchanged nothing. The user never reached the
    // dashboard. Logging out here is the bug, not the safety measure.
    expect(planLineSignIn({ isLoggedIn: true, idToken: LIVE, now: NOW })).toBe("exchange");
  });

  it("renews an expired token, because logout is what forces a new one", () => {
    // Without the logout the SDK replays the same dead token forever.
    expect(planLineSignIn({ isLoggedIn: true, idToken: DEAD, now: NOW })).toBe("renew");
  });

  it("logs in when there is no session at all", () => {
    expect(planLineSignIn({ isLoggedIn: false, idToken: null, now: NOW })).toBe("login");
    // A first-time visitor must never be logged out of nothing.
    expect(planLineSignIn({ isLoggedIn: false, idToken: LIVE, now: NOW })).toBe("login");
  });

  it("exchanges rather than renews when the token cannot be read", () => {
    // Unknown stays unknown: discarding a session over an unreadable cache
    // would sign out users whose token was fine. The exchange then reports the
    // real reason — missing openid scope, or no consent.
    expect(planLineSignIn({ isLoggedIn: true, idToken: null, now: NOW })).toBe("exchange");
    expect(planLineSignIn({ isLoggedIn: true, idToken: "garbage", now: NOW })).toBe("exchange");
  });

  it("never renews on a logged-out session, whatever the token says", () => {
    // logout() on a session that is not there is meaningless, and a stale token
    // string left over from a previous visit must not drive the decision.
    expect(planLineSignIn({ isLoggedIn: false, idToken: DEAD, now: NOW })).toBe("login");
  });
});
