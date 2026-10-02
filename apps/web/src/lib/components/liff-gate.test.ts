import { describe, expect, it } from "vitest";
import { createRouterPathSource, decideAfterSignIn, decideGate, isUngatedPath, normalizePath } from "./liff-gate";

describe("isUngatedPath", () => {
  it("keeps the legal documents readable", () => {
    // These are the routes the LINE console points a reviewer at. Gating them
    // means the privacy policy URL resolves to a login or pending card.
    expect(isUngatedPath("/privacy")).toBe(true);
    expect(isUngatedPath("/terms")).toBe(true);
  });

  it("keeps the sign-in page reachable", () => {
    // Observed in production 2026-10-01: a desktop browser holding an expired
    // cached LIFF token got the stale-session card INSTEAD of /login, so the
    // email form, the demo button and the legal links underneath it were
    // unreachable. A gate that replaces the sign-in surface with "sign in
    // again" is a dead end for anyone who is not signing in with LINE.
    expect(isUngatedPath("/login")).toBe(true);
    expect(isUngatedPath("/login/")).toBe(true);
  });

  it("tolerates a trailing slash, which the router can hand back", () => {
    expect(isUngatedPath("/privacy/")).toBe(true);
    expect(isUngatedPath("/terms/")).toBe(true);
  });

  it("still gates every product route", () => {
    // A prefix match would be the easy mistake here: "/privacy-policy" and
    // "/terms-of-service" are not the legal documents, and "/logins" is not
    // the sign-in page.
    expect(isUngatedPath("/")).toBe(false);
    expect(isUngatedPath("/dashboard")).toBe(false);
    expect(isUngatedPath("/privacy-policy")).toBe(false);
    expect(isUngatedPath("/terms-of-service")).toBe(false);
    expect(isUngatedPath("/dashboard/privacy")).toBe(false);
    expect(isUngatedPath("/logins")).toBe(false);
  });
});

/**
 * What the gate shows, decided without a LINE client.
 *
 * The bug this exists to catch cannot be reproduced by pressing buttons: it
 * needs a browser whose LIFF cache holds an expired ID token while the API has
 * already issued a working session. So the decision is pure and the states are
 * named, and the production case is written out as a case below.
 */
describe("decideGate", () => {
  it("renders the app when the API already issued a session, however stale the LINE token is", () => {
    // The production case, measured 2026-10-01 against
    // https://laundrytwin.duckdns.org: /api/me answered 200 with an owner grant
    // while /dashboard showed "เซสชัน LINE หมดอายุแล้ว" and refused to render.
    // The ID token is the thing that CREATES a session; once one exists, an
    // expired copy cached in the browser says nothing about the session's
    // validity, and blocking on it locks a signed-in owner out of the product.
    expect(
      decideGate({ bypass: false, state: "stale", pendingAccess: false, sessionUsable: true })
    ).toBe("render");
  });

  it("still blocks on a stale token when there is no usable session", () => {
    // The other half, and the case the stale card was built for: with no
    // session, "sign in with LINE again" is the only action that can help.
    expect(
      decideGate({ bypass: false, state: "stale", pendingAccess: false, sessionUsable: false })
    ).toBe("stale");
  });

  it("treats a LINE failure as irrelevant once a session exists", () => {
    // The SDK failing to initialize, or the exchange erroring, is a problem
    // only for someone who still needs a session. An owner who already has one
    // is not blocked by it.
    expect(
      decideGate({ bypass: false, state: "error", pendingAccess: false, sessionUsable: true })
    ).toBe("render");
  });

  it("shows the pending-access card only when the visitor has no session", () => {
    // ACCESS_PENDING means the exchange was refused for want of a grant, so
    // there is no session to render with — and if one exists anyway, the
    // visitor can reach the product and read why.
    expect(
      decideGate({ bypass: false, state: "ready", pendingAccess: true, sessionUsable: false })
    ).toBe("pending");
    expect(
      decideGate({ bypass: false, state: "ready", pendingAccess: true, sessionUsable: true })
    ).toBe("render");
  });

  it("shows the checking state while it is still loading", () => {
    expect(
      decideGate({ bypass: false, state: "loading", pendingAccess: false, sessionUsable: false })
    ).toBe("loading");
  });

  it("never blocks an ungated path, even mid-exchange", () => {
    // /login, /privacy and /terms hold no branch data. A card that replaces
    // them is not protecting anything.
    for (const state of ["loading", "stale", "error", "ready"] as const) {
      expect(decideGate({ bypass: true, state, pendingAccess: true, sessionUsable: false })).toBe("render");
    }
  });
});

/**
 * Where a browser that just signed in is sent, decided without a LINE client.
 *
 * The production case, reported 2026-10-02: pressing "เข้าสู่ระบบด้วย LINE"
 * signed the user in and left them on the sign-in form, and a second press was
 * needed to reach the dashboard. Nothing about the exchange failed — it is the
 * navigation that was dropped, and only on the leg where LINE redirects.
 */
describe("decideAfterSignIn", () => {
  it("sends a signed-in browser off the sign-in page", () => {
    // The production case. The gate returned from the LINE redirect holding a
    // working session, on /login, and rendered — because /login is ungated, so
    // `decideGate` answers "render" — which left the user looking at a form
    // asking them to sign in when they already had.
    expect(decideAfterSignIn("/login", true)).toBe("/dashboard");
  });

  it("tolerates the trailing slash the router can hand back", () => {
    // A `/login` check that passes on one navigation and fails on the next is
    // the same bug wearing a different hat, so both spellings must redirect.
    expect(decideAfterSignIn("/login/", true)).toBe("/dashboard");
  });

  it("leaves a browser with no session exactly where it is", () => {
    // The ordinary first visit: no session, so the form is the correct thing
    // to show and there is nowhere to send the visitor. Bouncing them to
    // /dashboard would land them on `_authenticated`'s 401 redirect anyway,
    // with a wasted round trip instead of a sign-in form.
    expect(decideAfterSignIn("/login", false)).toBeNull();
  });

  it("does not touch the legal documents", () => {
    // These are ungated for a reason that the redirect must not undo: a
    // signed-in visitor who followed a link to the privacy policy has to stay
    // on the document. Only /login asks a question the session already answered.
    expect(decideAfterSignIn("/privacy", true)).toBeNull();
    expect(decideAfterSignIn("/terms", true)).toBeNull();
    expect(decideAfterSignIn("/privacy/", true)).toBeNull();
  });

  it("leaves every product route alone", () => {
    // `/dashboard` in particular: after `login.tsx` redirects there, the gate's
    // effect runs again with a session on a product route. A redirect fired
    // from /dashboard to /dashboard would be a reload loop on a working app.
    expect(decideAfterSignIn("/dashboard", true)).toBeNull();
    expect(decideAfterSignIn("/", true)).toBeNull();
    expect(decideAfterSignIn("/machines", true)).toBeNull();
  });

  it("is not fooled by a path that merely starts with /login", () => {
    // The easy mistake, and the same class as the prefix bug in
    // `isUngatedPath`: "/logins" is not the sign-in page, and redirecting it
    // would either 404 or silently drop the visitor somewhere else.
    expect(decideAfterSignIn("/logins", true)).toBeNull();
    expect(decideAfterSignIn("/login-history", true)).toBeNull();
  });
});

describe("normalizePath", () => {
  it("strips one trailing slash but leaves the root alone", () => {
    // "/" must not become "", which would match nothing and so silently
    // re-gate the root.
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/login")).toBe("/login");
    expect(normalizePath("/login/")).toBe("/login");
  });
});

/**
 * A stand-in for the router, with the two members the gate actually reads.
 * Navigation is modelled the way the real router behaves: `latestLocation` is
 * replaced first, then listeners fire.
 */
function fakeRouter(initialPath: string) {
  let listeners: Array<() => void> = [];
  const router = {
    latestLocation: { pathname: initialPath },
    subscribe(event: "onResolved", listener: () => void) {
      if (event !== "onResolved") throw new Error(`unexpected event ${event}`);
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((entry) => entry !== listener);
      };
    },
    navigateTo(pathname: string) {
      router.latestLocation = { pathname };
      for (const listener of [...listeners]) listener();
    },
    get listenerCount() {
      return listeners.length;
    }
  };
  return router;
}

describe("createRouterPathSource", () => {
  it("reads the current path without waiting for a navigation", () => {
    // The first render happens before RouterProvider mounts. If getPath()
    // returned nothing until the first onResolved, the gate would flash the
    // pending card at exactly the visitor the bypass exists for.
    const source = createRouterPathSource(fakeRouter("/privacy"));
    expect(source.getPath()).toBe("/privacy");
    expect(isUngatedPath(source.getPath())).toBe(true);
  });

  it("tracks navigation, so leaving a legal route re-arms the gate", () => {
    const router = fakeRouter("/privacy");
    const source = createRouterPathSource(router);
    const seen: boolean[] = [isUngatedPath(source.getPath())];

    const unsubscribe = source.subscribe(() => seen.push(isUngatedPath(source.getPath())));
    router.navigateTo("/dashboard");
    router.navigateTo("/terms");
    router.navigateTo("/dashboard");
    unsubscribe();
    router.navigateTo("/privacy");

    // Ungated -> gated -> ungated -> gated, and the final navigation after
    // unsubscribing is not observed.
    expect(seen).toEqual([true, false, true, false]);
  });

  it("unsubscribes cleanly, so a remount does not leak listeners", () => {
    // StrictMode double-invokes effects in development. Without a real
    // unsubscribe the gate would keep notifying a dead subscriber.
    const router = fakeRouter("/dashboard");
    const source = createRouterPathSource(router);
    source.subscribe(() => {})();
    expect(router.listenerCount).toBe(0);
  });
});
