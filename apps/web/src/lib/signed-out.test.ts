import { afterEach, describe, expect, it, vi } from "vitest";
import { clearLiffSignedOut, isLiffSignedOut, markLiffSignedOut } from "../liff";
import { decideMountExchange, decideMountExchangeForThisBrowser } from "./components/liff-gate";

/**
 * The signed-out marker, and the decision the gate makes from it.
 *
 * Measured defect (production, 2026-11-08, real LINE app on Android): pressing
 * "ออกจากระบบ" revoked both sessions (200 each) and then
 * `POST /api/auth/liff/exchange` answered 200 at +0.58 s, `GET /api/me` 200, and
 * the browser was back on `/dashboard`. The revocation worked; the full page
 * load the sign-out itself performs re-authenticated, because the gate exchanges
 * a cached token on every path and nothing recorded that the user had left.
 *
 * This file pins the two halves that fix it — the stored marker and the pure
 * decision — because the behaviour cannot be reproduced without a real LINE
 * client, and a playwright spec that aborts `*.line.me` never has a token to
 * exchange, so it would pass against the broken build too.
 */
function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    dump: () => Object.fromEntries(store)
  };
}

/** A JWT-shaped token; only the `exp` claim is read, and only for presentation. */
function tokenExpiringIn(seconds: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }));
  return `header.${payload}.signature`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signed-out marker", () => {
  it("round-trips: marked means signed out until it is cleared", () => {
    vi.stubGlobal("localStorage", fakeStorage());

    expect(isLiffSignedOut()).toBe(false);
    markLiffSignedOut();
    expect(isLiffSignedOut()).toBe(true);
    clearLiffSignedOut();
    expect(isLiffSignedOut()).toBe(false);
  });

  it("does not treat any other stored value as a sign-out", () => {
    // The asymmetry that matters: a value this build did not write must leave
    // the automatic exchange ON. Guessing "signed out" from a stray entry would
    // stop a first-time visitor from signing in at all.
    for (const value of ["0", "", "true", "signed-out", "yes"]) {
      const storage = fakeStorage({ liff_signed_out: value });
      vi.stubGlobal("localStorage", storage);
      expect(isLiffSignedOut()).toBe(false);
    }
  });

  it("survives storage that throws, as private mode does", () => {
    // A sign-out must never fail because storage is unavailable: the
    // revocations have already been sent by the time this runs.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      }
    });

    expect(() => markLiffSignedOut()).not.toThrow();
    expect(isLiffSignedOut()).toBe(false);
    expect(() => clearLiffSignedOut()).not.toThrow();
  });
});

describe("decideMountExchange", () => {
  it("stays idle when LINE has no session, so nothing is exchanged", () => {
    expect(decideMountExchange({ isLoggedIn: false, idToken: null, signedOut: false })).toBe("idle");
  });

  it("exchanges a live token on an ordinary visit, which is what sign-in relies on", () => {
    // The 2026-10-02 fix depends on this: LINE returns the user to /login and
    // the gate exchanges there, without a second press.
    expect(
      decideMountExchange({ isLoggedIn: true, idToken: tokenExpiringIn(3600), signedOut: false })
    ).toBe("exchange");
  });

  it("refuses to exchange after a sign-out, even with a perfectly good token", () => {
    // The fix. A live token is exactly the state the defect exploited; it must
    // not be traded for a session until the user presses sign-in again.
    expect(
      decideMountExchange({ isLoggedIn: true, idToken: tokenExpiringIn(3600), signedOut: true })
    ).toBe("idle");
  });

  it("calls a signed-out browser idle rather than stale, even when the token is expired", () => {
    // A sign-out is not a stale session. The stale branch shows
    // "เซสชัน LINE หมดอายุแล้ว", which would be a false statement about a user
    // who deliberately signed out, and it offers a re-login the user did not ask
    // for.
    expect(
      decideMountExchange({ isLoggedIn: true, idToken: tokenExpiringIn(-3600), signedOut: true })
    ).toBe("idle");
  });

  it("still routes an expired token to the stale card when the user has not signed out", () => {
    expect(
      decideMountExchange({ isLoggedIn: true, idToken: tokenExpiringIn(-3600), signedOut: false })
    ).toBe("stale");
  });
});

/**
 * The seam the gate actually calls.
 *
 * `decideMountExchange` cannot see how `signedOut` was produced, so a widened
 * read (`!== null`, "any truthy value") passes every test above while silently
 * disabling sign-in for a first-time visitor. These cases read the marker from
 * storage, which is the line that would be widened.
 */
describe("decideMountExchangeForThisBrowser", () => {
  it("exchanges on a browser that has never signed out, because sign-in depends on it", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    expect(decideMountExchangeForThisBrowser({ isLoggedIn: true, idToken: tokenExpiringIn(3600) })).toBe(
      "exchange"
    );
  });

  it("exchanges when the stored value is not the one this build writes", () => {
    // "0" is a truthy string: accepting "any stored value" would read this as a
    // sign-out and leave a real visitor unable to sign in.
    vi.stubGlobal("localStorage", fakeStorage({ liff_signed_out: "0" }));
    expect(decideMountExchangeForThisBrowser({ isLoggedIn: true, idToken: tokenExpiringIn(3600) })).toBe(
      "exchange"
    );
  });

  it("stays idle on a browser that has signed out, token and all", () => {
    vi.stubGlobal("localStorage", fakeStorage({ liff_signed_out: "1" }));
    expect(decideMountExchangeForThisBrowser({ isLoggedIn: true, idToken: tokenExpiringIn(3600) })).toBe(
      "idle"
    );
  });
});
