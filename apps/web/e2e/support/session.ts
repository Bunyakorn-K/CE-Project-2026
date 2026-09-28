import type { Page } from "@playwright/test";

/**
 * Answers the app's `/api/*` calls from fixtures so the layout suite can run
 * against the built bundle with no API, no ClickHouse and no SQLite.
 *
 * Only `/api/me` has to be faked for the routes to render: `_authenticated.tsx`
 * resolves the session in `beforeLoad` and redirects to `/login` on anything
 * other than a 2xx. The rest are stubbed to keep the pages deterministic and
 * fast; a query that fails still renders the shell and the page header, which
 * is what the layout assertions read.
 *
 * The session mirrors the development auth bypass principal from
 * `apps/api/src/access-store.ts` (`Development Owner`, tenant-wide owner). That
 * name is load-bearing, though less than it was: the CSS comment above
 * `@media (max-width: 1173px)` in `styles.css` records that the 1174px threshold
 * was measured with it, and `.account-name` is what the threshold is actually
 * derived from. It renders 123.67px here, inside the `max-width: 130px` cap, so
 * the name has 6.33px of slack before it starts clipping and another 6.33px
 * before it moves the header at all. Changing this string to anything longer or
 * shorter than roughly 17 characters moves the width the inline nav needs, which
 * is the re-measure the comment asks for. The font half of the measurement is no
 * longer sensitive to the machine: `styles.css` self-hosts Noto Sans Thai, so
 * re-measuring on a host with a different system font set gives the same number.
 */
const DEVELOPMENT_OWNER_SESSION = {
  user: {
    id: "development-owner",
    name: "Development Owner",
    email: "development.owner@laundrytwin.local"
  },
  source: "development",
  grants: [{ id: "development-owner-grant", role: "owner", branchId: null }]
};

/** One grant row, so both the mobile card list and the desktop table render. */
const GRANTS = [
  {
    id: "grant-layout-fixture",
    userId: "development-owner",
    userName: "Development Owner",
    userEmail: "development.owner@laundrytwin.local",
    role: "owner",
    branchId: null,
    grantedAt: "2026-01-01T00:00:00.000Z"
  }
];

const RESPONSES: Record<string, unknown> = {
  "/api/me": DEVELOPMENT_OWNER_SESSION,
  "/api/report/branches": { branches: [] },
  "/api/admin/access-requests": { requests: [] },
  "/api/admin/grants": { grants: GRANTS }
};

export async function installStubbedSession(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname in RESPONSES) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(RESPONSES[pathname])
      });
      return;
    }
    // Unstubbed analytics endpoints stay unavailable. The pages surface that as
    // an error state rather than fabricating data, and the topbar, the nav and
    // the page header still render, which is what the suite measures.
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "REPORTING_SOURCE_UNAVAILABLE", message: "stubbed by the layout suite" } })
    });
  });
}

/** Waits until the authenticated shell is mounted, not merely for the document. */
export async function gotoAuthenticated(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator(".app-topbar").waitFor({ state: "visible" });
  await page.locator(".signout-button").waitFor({ state: "visible" });
}
