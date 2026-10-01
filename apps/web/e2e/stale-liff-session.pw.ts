import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { installStubbedSession } from "./support/session";

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

  test("leaves the sign-in page itself reachable, session or not", async ({ page }) => {
    await installStubbedSession(page);
    await blockLineEndpoint(page);

    await page.goto("/login");

    // The production page rendered the gate's card INSTEAD of this form. Every
    // affordance below was unreachable from a desktop browser.
    await expect(page.getByRole("button", { name: "เข้าสู่ระบบด้วย LINE" })).toBeVisible();
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.getByRole("link", { name: "นโยบายความเป็นส่วนตัว" })).toBeVisible();
    await expect(page.getByRole("link", { name: "ข้อกำหนดการใช้งาน" })).toBeVisible();
    await expect(page.locator(".liff-message-card")).toHaveCount(0);
  });
});
