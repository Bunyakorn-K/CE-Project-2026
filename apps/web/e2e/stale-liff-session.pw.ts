import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { DEVELOPMENT_OWNER_SESSION, installStubbedSession } from "./support/session";

/**
 * A blocking LINE gate must not hide the product or the sign-in page.
 *
 * Found in production on 2026-10-01, not by reading the code: at
 * `https://laundrytwin.duckdns.org`, `/api/me` answered 200 with an owner grant
 * while `/dashboard` rendered nothing but "เซสชัน LINE หมดอายุแล้ว". The LIFF
 * SDK keeps a token in localStorage past its 60-minute life and still reports
 * `isLoggedIn() === true`, so the gate blocked a browser that already held a
 * working session. `/login` was worse: the stale card replaced the email form,
 * the demo button and the legal links, leaving anyone not signing in with LINE
 * with no way forward.
 *
 * A real expired token cannot be reproduced here — the SDK discards a seeded
 * store, because it validates the cached access token against LINE's servers
 * first. These specs drive the gate into the same blocking state a different
 * way, by making LINE unreachable, and assert the two things that must hold
 * whatever the cause: a visitor with a session reaches the product, and every
 * visitor can reach a usable sign-in page. The state-by-state decision itself
 * is covered as a pure function in `liff-gate.test.ts`, where each state is
 * named; this suite is what proves the built bundle honours it.
 *
 * Requires a build with `VITE_LIFF_ID` baked in — the gate compiles every LIFF
 * branch out otherwise — so it skips rather than passing vacuously:
 *
 *   VITE_LIFF_ID=2011592166-uToRdTwS pnpm --filter @laundrytwin/web test:layout
 *
 * The value does not have to be a real LIFF ID. These specs abort every
 * `*.line.me` and `*.line-s.me` request, so the SDK never reaches LINE and the
 * placeholder is never used as a credential; it only has to be non-empty, so
 * the gate compiles its LIFF branches in. CI sets one for exactly this reason
 * (see `.github/workflows/ci.yml`): with the variable absent, all four specs
 * skipped on every run and CI reported a green `40 passed` that had silently
 * stopped covering the defect this file exists for. A skip that is correct on
 * one machine and invisible on another is the same failure as a threshold
 * measured on one platform.
 */

/**
 * Make the LINE SDK unreachable, so `liff.init()` rejects and the gate falls
 * into its blocking card. This is the state a stale token produces; the cause
 * differs and is deliberately not simulated.
 */
async function blockLineEndpoint(page: Page): Promise<void> {
  await page.route("**://*.line.me/**", (route) => route.abort());
  await page.route("**://*.line-s.me/**", (route) => route.abort());
}

test.describe("a LINE gate that cannot reach LINE", () => {
  test.skip(
    !process.env.VITE_LIFF_ID,
    "needs a build with VITE_LIFF_ID baked in; the gate compiles every LIFF branch out otherwise"
  );

  test("does not hide the dashboard from a visitor who has a session", async ({ page }) => {
    await installStubbedSession(page);
    await blockLineEndpoint(page);

    await page.goto("/dashboard");

    // The session is the API's answer, and it is a good one. Whatever the LINE
    // SDK is doing says nothing about it.
    await expect(page.locator(".app-topbar")).toBeVisible();
    await expect(page.locator(".signout-button")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("ภาพรวมการดำเนินงาน");
    await expect(page.getByText("ไม่สามารถเริ่ม LINE LIFF ได้")).toHaveCount(0);
  });

  test("leaves a visitor with no session a real sign-in page", async ({ page }) => {
    await installStubbedSession(page, { statuses: { "/api/me": 401 } });
    await blockLineEndpoint(page);

    await page.goto("/dashboard");

    // The gate sits ABOVE RouterProvider, so while it blocks, the
    // `_authenticated` redirect to /login never runs. A sessionless visitor was
    // stranded on /dashboard behind a card whose only action retried the
    // request that had just failed. The alternative link is the way out.
    await expect(page.getByRole("link", { name: "เข้าสู่ระบบด้วยอีเมลแทน" })).toBeVisible();
    await page.getByRole("link", { name: "เข้าสู่ระบบด้วยอีเมลแทน" }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
  });

  test("never shows the SDK's English prose on a Thai page", async ({ page }) => {
    // No session, so the card is the correct outcome and its wording is what
    // the visitor reads. With a session there is no card at all — see the
    // first spec — which is why this needs the 401.
    await installStubbedSession(page, { statuses: { "/api/me": 401 } });
    await blockLineEndpoint(page);

    await page.goto("/dashboard");

    // `initLiff` surfaces the raw failure it caught. Before, a network drop
    // rendered the card body as "Failed to fetch" — the same untranslated
    // server-string defect `api-errors.ts` prevents on the API side.
    //
    // Scoped to the body paragraph: the heading carries "LINE LIFF" as a
    // product name, which is established copy, not leaked SDK prose.
    const body = page.locator(".liff-message-card p").first();
    await expect(body).toHaveText("ไม่สามารถเชื่อมต่อกับ LINE ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
    await expect(body).not.toContainText(/[A-Za-z]{4,}\s+[A-Za-z]{4,}/);
  });

  test("leaves a sessionless visitor a real sign-in page", async ({ page }) => {
    await installStubbedSession(page, { statuses: { "/api/me": 401 } });
    await blockLineEndpoint(page);

    await page.goto("/login");

    // The production page rendered the gate's card INSTEAD of this form. Every
    // affordance below was unreachable from a desktop browser.
    //
    // No session: with one, the gate sends the browser to /dashboard instead —
    // see the "signed in but sitting on the sign-in form" spec below, which is
    // the other half of the same rule. Both are correct, and conflating them is
    // what let the original defect through: a visitor who HAS signed in was
    // being asserted to have no way forward, which read as a pass.
    await expect(page.getByRole("button", { name: "เข้าสู่ระบบด้วย LINE" })).toBeVisible();
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.getByRole("link", { name: "นโยบายความเป็นส่วนตัว" })).toBeVisible();
    await expect(page.getByRole("link", { name: "ข้อกำหนดการใช้งาน" })).toBeVisible();
    await expect(page.locator(".liff-message-card")).toHaveCount(0);
  });
});

/**
 * A browser that is signed in and shown a sign-in form.
 *
 * Reported in production on 2026-10-02: pressing "เข้าสู่ระบบด้วย LINE" signed
 * the user in and left them on the form, and a second press was required to
 * reach the dashboard. The cause is a fact about the LINE redirect. When the
 * SDK has no session, the press fires `liff.login()` with a `redirectUri` of
 * `window.location.href` — on /login, that is /login — so LINE returns the user
 * to the sign-in page, where the gate runs a fresh exchange, succeeds, and
 * holds a session cookie. The only code that navigates after a LINE sign-in
 * lives in the click handler of the page LINE just navigated away from, so it
 * does not run on this load. The exchange was never broken; the navigation was,
 * and only on that one leg.
 *
 * The `exchange` plan was verified end to end in the real LINE client on
 * 2026-10-01, but from a browser already signed into LINE — where no redirect
 * happens and this leg is never entered. The unreachable leg was the broken one.
 *
 * Reproduced here without a LINE client: LINE unreachable plus a working
 * session is the same state the gate is in after the redirect — sessionUsable,
 * on /login — and the redirect decision is the same pure function either way.
 */
test.describe("a browser signed in and left on the sign-in page", () => {
  test.skip(
    !process.env.VITE_LIFF_ID,
    "needs a build with VITE_LIFF_ID baked in; the gate compiles every LIFF branch out otherwise"
  );

  test("goes to the dashboard on one press, not two", async ({ page }) => {
    await installStubbedSession(page);
    await blockLineEndpoint(page);

    await page.goto("/login");

    // No click. The session already exists, exactly as it does after the LINE
    // redirect returns — so the gate must carry the browser to the product by
    // itself. Before this, /login rendered and stayed.
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.locator(".app-topbar")).toBeVisible();
  });

  test("never leaves the legal documents, session or not", async ({ page }) => {
    await installStubbedSession(page);
    await blockLineEndpoint(page);

    await page.goto("/privacy");

    // The gate is ungated here so the policy stays readable, and the
    // post-sign-in redirect must respect that: a signed-in visitor who
    // followed a link to the privacy policy has to stay on the document.
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("does not reload-loop once it is already on the dashboard", async ({ page }) => {
    await installStubbedSession(page);
    await blockLineEndpoint(page);

    await page.goto("/dashboard");

    // The redirect fires on the condition "session and on /login". A gate that
    // fired it on any path would reload /dashboard into itself forever, and the
    // pure-function spec is what keeps that honest — this asserts the shipped
    // bundle settles instead.
    await expect(page.locator(".app-topbar")).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.locator(".app-topbar")).toBeVisible();
  });
});

/**
 * A browser that signs out.
 *
 * Reported in production on 2026-10-02, immediately after the redirect above
 * shipped: pressing "ออกจากระบบ" navigated to `/login` and the browser went
 * straight back to `/dashboard`, still signed in.
 *
 * Two faults stacked. The sign-out POST carried no content-type, so Better Auth
 * refused it **415** and never revoked the session cookie — the browser was on
 * the sign-in page holding a live session. Then the redirect above, which
 * correctly sends a *signed-in* browser off `/login`, could not tell that
 * session had just been cancelled: `LiffGate` sits above `RouterProvider` and
 * probes once on mount with `[]` deps, so a client-side navigation left its
 * flag describing the session as it was before the sign-out. It fired
 * `/dashboard`, `/api/me` answered 200 because the cookie was never cleared,
 * and the user was returned to the product they had just left.
 *
 * The dangerous half is what the pair made possible. A sign-out that does not
 * hold is worse than no sign-out button at all: the UI says the session ended,
 * so a user on a shared or public machine believes it did.
 *
 * So these specs assert the session is actually **revoked** — the sign-out
 * request carries the JSON content-type Better Auth requires, and the mock API
 * drops to 401 afterwards — rather than only that the URL changed. The old
 * end-to-end click in `layout.pw.ts` asserted `/login` and passed throughout.
 */
test.describe("signing out", () => {
  test.skip(
    !process.env.VITE_LIFF_ID,
    "needs a build with VITE_LIFF_ID baked in; the gate compiles every LIFF branch out otherwise"
  );

  /**
   * A stubbed API where signing out genuinely ends the session: `/api/me` starts
   * 200 and becomes 401 once the sign-out request lands, and the sign-out route
   * is asserted to be the one that was called with the header it needs.
   */
  async function installRevocableSession(page: Page): Promise<{
    signOutRequests: Array<{ contentType: string | null; body: string | undefined }>;
    /** Every status the stub served for `/api/me`, in order. */
    meStatuses: number[];
  }> {
    const signOutRequests: Array<{ contentType: string | null; body: string | undefined }> = [];
    const meStatuses: number[] = [];
    let revoked = false;

    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/auth/sign-out") {
        signOutRequests.push({
          contentType: route.request().headers()["content-type"] ?? null,
          body: route.request().postData() ?? undefined
        });
        revoked = true;
        await route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' });
        return;
      }
      if (url.pathname === "/api/me") {
        meStatuses.push(revoked ? 401 : 200);
        await route.fulfill({
          status: revoked ? 401 : 200,
          contentType: "application/json",
          body: revoked ? "" : JSON.stringify(DEVELOPMENT_OWNER_SESSION)
        });
        return;
      }
      // Unstubbed report endpoints stay unavailable, exactly as the shared stub
      // answers them: the pages surface an error state rather than fabricating
      // data. A 200 with a body missing its `totals` is worse than either — it
      // throws inside the dashboard and takes the whole shell down with it, so
      // the sign-out button would not even be present to click.
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "REPORTING_SOURCE_UNAVAILABLE", message: "stubbed by the layout suite" } })
      });
    });

    return { signOutRequests, meStatuses };
  }

  test("revokes the session, and the browser stays signed out", async ({ page }) => {
    const { signOutRequests } = await installRevocableSession(page);
    await blockLineEndpoint(page);

    await page.goto("/dashboard");
    await expect(page.locator(".app-topbar")).toBeVisible();

    await page.locator(".signout-button").click();

    // The request itself, not the destination. Better Auth parses a JSON body on
    // this endpoint, so a POST without the header is refused 415 before the
    // handler runs and the cookie is never cleared — which is what left the
    // browser signed in on 2026-10-02.
    await expect.poll(() => signOutRequests.length).toBe(1);
    expect(signOutRequests[0]?.contentType).toContain("application/json");

    // And the outcome: on /login, with a session the API now denies.
    await expect(page).toHaveURL(/\/login$/);

    // The trap the pair of faults set. The gate redirects a *signed-in* browser
    // off /login, and after a client-side navigation its `sessionUsable` flag
    // still described the session from before the sign-out — so it fired
    // /dashboard, where /api/me answered 200 and the user was put back in.
    // Reloading remounts the gate, which re-probes and finds the 401.
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator(".app-topbar")).toHaveCount(0);
  });

  test("does not return to the dashboard on a later visit either", async ({ page }) => {
    const { meStatuses } = await installRevocableSession(page);
    await blockLineEndpoint(page);

    await page.goto("/dashboard");
    await expect(page.locator(".app-topbar")).toBeVisible();
    await page.locator(".signout-button").click();
    await expect(page).toHaveURL(/\/login$/);

    // Typing the product URL by hand must not restore access.
    await page.goto("/dashboard");

    // The claim is that the product does not render, NOT that the URL changes.
    // With LINE unreachable the gate blocks above `RouterProvider`, so
    // `_authenticated`'s redirect to /login never runs and the browser sits on
    // /dashboard behind the LINE error card. That is the designed shape of the
    // gate — asserting the URL instead would be asserting an accident of which
    // layer happens to run first, and would have "passed" for a browser that was
    // merely misrouted while still holding the session.
    await expect(page.locator(".app-topbar")).toHaveCount(0);
    await expect(page.locator(".signout-button")).toHaveCount(0);
    await expect(page.locator(".liff-message-card")).toBeVisible();

    // And the browser ASKS, and is REFUSED. This is the half that says the
    // revocation held rather than the gate merely hiding the product: the
    // product is absent because `/api/me` answered 401, not because a card is
    // covering it.
    //
    // It is asserted on the STATUSES THE STUB SERVED, not on the URL, and the
    // distinction is the whole point. An earlier version of this spec unblocked
    // LINE, reloaded, and asserted `toHaveURL(/\/login$/)` — reasoning that
    // "with LINE reachable, the API is what refuses". `unroute` does not make
    // LINE reachable: it stops aborting the request and sends it to the real
    // internet, where a placeholder LIFF ID still cannot initialise, so the gate
    // stayed in its `init`-error card and no `_authenticated` redirect ever ran.
    // Measured, not assumed: with the card still mounted and the URL still
    // `/dashboard`, that spec failed on `main` from `efc2857` onward — five
    // consecutive red CI runs, none of them touching this file. The assertion
    // could only ever have passed against a real LINE client.
    //
    // Asserting the served statuses asks the question that is actually
    // answerable here, and it cannot be satisfied by a card that happens to be
    // painted over a browser still holding a session — which is precisely the
    // failure the "browser is merely misrouted" comment above warns about.
    expect(meStatuses.length).toBeGreaterThan(0);
    expect(meStatuses.at(-1)).toBe(401);
  });
});
