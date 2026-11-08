import { afterEach, describe, expect, it, vi } from "vitest";
import { performSignOut, signOutRequest } from "./app-shell";

/**
 * The sign-out request, on its own.
 *
 * Reported in production on 2026-10-02: pressing "ออกจากระบบ" left the browser
 * on `/dashboard`, still signed in. Two independent faults stacked there, and
 * this file exists for the one that no other test could see.
 *
 * The fault: Better Auth's sign-out handler parses a JSON body, so the POST the
 * shell was making — which sent no body and therefore no content-type — was
 * refused **415** before the handler ran. Nothing cleared the session cookie.
 * Measured on production the same day: `curl -X POST /api/auth/sign-out` → 415,
 * and the identical request with `content-type: application/json` → 200
 * `{"success":true}`.
 *
 * Why nothing else caught it. The button is present, hit-testable and in-viewport
 * at every width (`layout.pw.ts` asserts all three). The click navigates to
 * `/login`, which the same file asserts end to end. Both were true while the
 * session was never revoked: the UI moved, and the cookie did not. A test that
 * asks "did the app go to /login?" is asking the wrong question — the browser
 * can be on the sign-in page and still hold a valid session, which is exactly
 * what the second fault then exploited.
 */
describe("signOutRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares a JSON body, so Better Auth's handler runs instead of refusing 415", async () => {
    // The one assertion that distinguishes a working sign-out from a no-op.
    // Verified against production on 2026-10-02: this header is the whole
    // difference between 415 and 200.
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await signOutRequest();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(init.body).toBe("{}");
  });

  it("posts, and sends the session cookie so the revocation applies to this browser", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await signOutRequest();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/auth/sign-out");
    expect(init.method).toBe("POST");
    // Without the cookie the request revokes a session the browser never held,
    // and answers 200 while doing nothing — the same silent no-op as the 415.
    expect(init.credentials).toBe("include");
  });
});

/**
 * The sign-out sequence, which no UI assertion can see.
 *
 * Measured in production on 2026-11-08 (real LINE app on Android): both
 * revocations answered 200 and, within a second, the gate had exchanged the
 * still-cached LINE token for a new session — `POST /api/auth/liff/exchange`
 * 200, `GET /api/me` 200, browser back on `/dashboard`. The button worked; the
 * page load it performs undid it.
 *
 * So the assertions here are about order, not about URLs: the marker has to be
 * on disk at the moment `replace` runs, and every step has to happen even when a
 * revocation rejects.
 */
describe("performSignOut", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubStorage(readBack?: (value: string | null | undefined) => void) {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key)
    });
    return {
      atNavigation: () => readBack?.(storage.get("liff_signed_out") ?? null),
      value: () => storage.get("liff_signed_out") ?? null
    };
  }

  function buildDeps(overrides: Partial<Parameters<typeof performSignOut>[0]> = {}) {
    const calls: string[] = [];
    const base = {
      requestSignOut: async () => {
        calls.push("requestSignOut");
        return new Response("{}", { status: 200 });
      },
      requestLiffLogout: async () => {
        calls.push("requestLiffLogout");
        return new Response("{}", { status: 200 });
      },
      dropLiffToken: () => void calls.push("dropLiffToken"),
      clearClientSession: () => void calls.push("clearClientSession"),
      replace: (path: string) => void calls.push(`replace:${path}`)
    };
    return { calls, deps: { ...base, ...overrides } };
  }

  it("marks the browser signed out before the navigation the gate will re-run", async () => {
    // A marker written after `replace` never lands, and one written after the
    // page load arrives too late: the gate's mount effect has already exchanged.
    let markerAtNavigation: string | null = "not-read";
    const storage = stubStorage();
    const { deps } = buildDeps({
      replace: () => {
        markerAtNavigation = storage.value();
      }
    });

    await performSignOut(deps);

    expect(markerAtNavigation).toBe("1");
  });

  it("runs both revocations even when one of them rejects", async () => {
    // A 415 from Better Auth and a dead `liff/logout` are different faults, and
    // either one leaves a live session. `Promise.all` would skip the second.
    stubStorage();
    const { calls, deps } = buildDeps({
      requestSignOut: async () => {
        calls.push("requestSignOut");
        throw new Error("415");
      }
    });

    await performSignOut(deps);

    expect(calls).toContain("requestSignOut");
    expect(calls).toContain("requestLiffLogout");
    expect(calls).toContain("replace:/login");
  });

  it("drops the LINE token and clears the client session before navigating", async () => {
    // The token is the second lock: with it gone the next press is a real
    // `liff.login()` instead of a silent exchange.
    stubStorage();
    const { calls, deps } = buildDeps();

    await performSignOut(deps);

    expect(calls.slice(-3)).toEqual(["dropLiffToken", "clearClientSession", "replace:/login"]);
  });

  it("navigates to /login once, as a full page load rather than a router push", async () => {
    // The remount is the point: `LiffGate` probes once on mount, so a
    // client-side navigation would leave it describing the session as it was
    // before the sign-out.
    stubStorage();
    const { calls, deps } = buildDeps();

    await performSignOut(deps);

    expect(calls.filter((call) => call.startsWith("replace:"))).toEqual(["replace:/login"]);
  });
});
