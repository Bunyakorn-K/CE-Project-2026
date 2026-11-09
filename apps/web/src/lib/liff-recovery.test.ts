import { afterEach, describe, expect, it, vi } from "vitest";
import { bumpRenewAttempts, readRenewAttempts, resetRenewAttempts } from "../liff";
import {
  MAX_RENEW_ATTEMPTS,
  classifyExchangeFailure,
  decideRecovery,
  exchangeIdentity
} from "./components/liff-gate";

/**
 * Typed exchange failures and the recovery decision.
 *
 * Before this, every 401 from `POST /api/auth/liff/exchange` was one fact and
 * the recovery was a button that re-ran the same failing request. Two failures
 * that need different answers were therefore identical from the UI's side: a
 * throttle (429, wait) and an expired token (401, get a new one), and a dropped
 * connection (no response) looked like the server rejecting the identity.
 *
 * The guards are the interesting part, not the mapping: a deliberate sign-out
 * and a legal document must both be unreachable by any automatic navigation, and
 * a device whose clock makes every token look expired must stop rather than loop.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classifyExchangeFailure", () => {
  it("reads a rejected token as expired, whichever code the API used", () => {
    // `liffError` answers 401 with LIFF_VERIFICATION_FAILED for a LINE rejection
    // (expired, malformed, other channel) and LIFF_TOKEN_REJECTED from its
    // catch-all. Both mean "get a new token", and neither means "server down".
    expect(classifyExchangeFailure({ status: 401, code: "LIFF_TOKEN_REJECTED" })).toEqual({ kind: "expired" });
    expect(classifyExchangeFailure({ status: 401, code: "LIFF_VERIFICATION_FAILED" })).toEqual({ kind: "expired" });
    expect(classifyExchangeFailure({ status: 401 })).toEqual({ kind: "expired" });
  });

  it("keeps a throttle separate from an expiry, with its wait", () => {
    // Waiting is the only fix; renewing would spend another exchange and hit the
    // same 429, which is why this must not share the expired branch.
    expect(classifyExchangeFailure({ status: 429, retryAfterSeconds: 12 })).toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 12
    });
    expect(classifyExchangeFailure({ status: 429 })).toEqual({ kind: "rate_limited", retryAfterSeconds: null });
  });

  it("calls a gateway or config failure server-side, not the visitor's fault", () => {
    expect(classifyExchangeFailure({ status: 502 })).toEqual({ kind: "server" });
    expect(classifyExchangeFailure({ status: 503 })).toEqual({ kind: "server" });
  });

  it("splits the two 403s the API distinguishes", () => {
    expect(classifyExchangeFailure({ status: 403, code: "ACCESS_PENDING" })).toEqual({ kind: "pending" });
    expect(classifyExchangeFailure({ status: 403, code: "ACCESS_NOT_GRANTED" })).toEqual({ kind: "not_granted" });
    expect(classifyExchangeFailure({ status: 403, code: "SOMETHING_ELSE" })).toEqual({ kind: "other", status: 403 });
  });

  it("reads no response at all as network, never as a rejection", () => {
    // status 0 is what `exchangeIdentity` sets when the fetch itself throws.
    expect(classifyExchangeFailure({ status: 0 })).toEqual({ kind: "network" });
    expect(classifyExchangeFailure({ code: "NETWORK" })).toEqual({ kind: "network" });
  });

  it("leaves the rest as other, keeping the status", () => {
    expect(classifyExchangeFailure({ status: 500 })).toEqual({ kind: "other", status: 500 });
    expect(classifyExchangeFailure({ status: 400, code: "INVALID_LIFF_TOKEN" })).toEqual({ kind: "other", status: 400 });
  });
});

describe("decideRecovery", () => {
  const base = {
    failure: { kind: "expired" as const },
    attempts: 0,
    signedOut: false,
    isInClient: false,
    ungated: false
  };

  it("never acts after a deliberate sign-out", () => {
    // The 2026-11-08 defect in one assertion: the gate exchanged a live token
    // straight after the sign-out revocations and put the browser back on
    // /dashboard. Any automatic path that fires here re-opens it.
    for (const failure of [
      { kind: "expired" as const },
      { kind: "pending" as const },
      { kind: "server" as const },
      { kind: "rate_limited" as const, retryAfterSeconds: 5 }
    ]) {
      expect(decideRecovery({ ...base, failure, signedOut: true })).toBe("idle");
    }
  });

  it("never navigates away from a legal document", () => {
    expect(decideRecovery({ ...base, ungated: true })).toBe("idle");
  });

  it("renews an expired token, and counts the attempts it has left", () => {
    expect(decideRecovery(base)).toBe("renew-external");
    expect(decideRecovery({ ...base, attempts: MAX_RENEW_ATTEMPTS - 1 })).toBe("renew-external");
  });

  it("stops at the bound instead of looping on a skewed clock", () => {
    expect(decideRecovery({ ...base, attempts: MAX_RENEW_ATTEMPTS })).toBe("terminal");
    expect(decideRecovery({ ...base, attempts: 99 })).toBe("terminal");
  });

  it("renews by reload inside LINE, where login() cannot be used", () => {
    expect(decideRecovery({ ...base, isInClient: true })).toBe("renew-in-client");
    // The bound applies there too — the reload loop is the same loop.
    expect(decideRecovery({ ...base, isInClient: true, attempts: MAX_RENEW_ATTEMPTS })).toBe("terminal");
  });

  it("routes each remaining failure to its own answer", () => {
    expect(decideRecovery({ ...base, failure: { kind: "pending" } })).toBe("pending");
    expect(decideRecovery({ ...base, failure: { kind: "not_granted" } })).toBe("denied");
    expect(decideRecovery({ ...base, failure: { kind: "rate_limited", retryAfterSeconds: 30 } })).toBe("rate-limited");
    expect(decideRecovery({ ...base, failure: { kind: "server" } })).toBe("error");
    expect(decideRecovery({ ...base, failure: { kind: "network" } })).toBe("error");
    expect(decideRecovery({ ...base, failure: { kind: "other", status: 400 } })).toBe("error");
  });
});

describe("renewal budget", () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      dump: () => Object.fromEntries(store)
    };
  }

  it("is cleared by a successful exchange, and only by that", async () => {
    // The reset lives in `exchangeIdentity`, on the 200 path. A reset on mount
    // would re-arm a device stuck in the loop: the bound would go back to zero
    // on every page load, which is never what the user observes as "it stopped".
    vi.stubGlobal("localStorage", fakeStorage({ liff_renew_attempt: "2" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));

    await exchangeIdentity(
      { displayName: "n", userId: "u", idToken: "t" },
      new AbortController().signal
    );

    expect(readRenewAttempts()).toBe(0);
  });

  it("is left alone when the exchange fails", async () => {
    vi.stubGlobal("localStorage", fakeStorage({ liff_renew_attempt: "2" }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "LIFF_TOKEN_REJECTED" } }), { status: 401 }))
    );

    await expect(
      exchangeIdentity({ displayName: "n", userId: "u", idToken: "t" }, new AbortController().signal)
    ).rejects.toBeInstanceOf(Error);
    expect(readRenewAttempts()).toBe(2);
  });

  it("counts up and resets", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    expect(readRenewAttempts()).toBe(0);
    expect(bumpRenewAttempts()).toBe(1);
    expect(bumpRenewAttempts()).toBe(2);
    expect(readRenewAttempts()).toBe(2);
    resetRenewAttempts();
    expect(readRenewAttempts()).toBe(0);
  });

  it("reads a corrupt value as zero rather than NaN", () => {
    // NaN would make `attempts >= MAX` false forever, which is a loop with no
    // bound — the one thing this counter exists to prevent.
    vi.stubGlobal("localStorage", fakeStorage({ liff_renew_attempt: "not-a-number" }));
    expect(readRenewAttempts()).toBe(0);
  });

  it("survives storage that throws", () => {
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
    expect(readRenewAttempts()).toBe(0);
    expect(() => bumpRenewAttempts()).not.toThrow();
    expect(() => resetRenewAttempts()).not.toThrow();
  });
});
