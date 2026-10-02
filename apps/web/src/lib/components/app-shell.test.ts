import { afterEach, describe, expect, it, vi } from "vitest";
import { signOutRequest } from "./app-shell";

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