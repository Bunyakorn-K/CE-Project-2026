import { describe, expect, it } from "vitest";
import { createRouterPathSource, isUngatedPath } from "./liff-gate";

describe("isUngatedPath", () => {
  it("keeps the legal documents readable", () => {
    // These are the routes the LINE console points a reviewer at. Gating them
    // means the privacy policy URL resolves to a login or pending card.
    expect(isUngatedPath("/privacy")).toBe(true);
    expect(isUngatedPath("/terms")).toBe(true);
  });

  it("tolerates a trailing slash, which the router can hand back", () => {
    expect(isUngatedPath("/privacy/")).toBe(true);
    expect(isUngatedPath("/terms/")).toBe(true);
  });

  it("still gates every product route", () => {
    // A prefix match would be the easy mistake here: "/privacy-policy" and
    // "/terms-of-service" are not the legal documents.
    expect(isUngatedPath("/")).toBe(false);
    expect(isUngatedPath("/login")).toBe(false);
    expect(isUngatedPath("/dashboard")).toBe(false);
    expect(isUngatedPath("/privacy-policy")).toBe(false);
    expect(isUngatedPath("/terms-of-service")).toBe(false);
    expect(isUngatedPath("/dashboard/privacy")).toBe(false);
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
