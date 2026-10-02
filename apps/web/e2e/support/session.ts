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
 * `@media (max-width: 1199px)` in `styles.css` records that the 1200px threshold
 * was measured with it, and `.account-name` is what the threshold is actually
 * derived from. The headroom test in `layout.pw.ts` now measures the real header
 * width on every run, so a change here reports itself as a threshold failure
 * rather than as an unexplained 83px topbar. It renders 123.67px here, inside
 * the `max-width: 130px` cap, so
 * the name has 6.33px of slack before it starts clipping and another 6.33px
 * before it moves the header at all. Changing this string to anything longer or
 * shorter than roughly 17 characters moves the width the inline nav needs, which
 * is the re-measure the comment asks for. The font half of the measurement is no
 * longer sensitive to the machine: `styles.css` self-hosts Noto Sans Thai, so
 * re-measuring on a host with a different system font set gives the same number.
 */
export const DEVELOPMENT_OWNER_SESSION = {
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

/** A technician session: one branch, no revenue. Used to assert that the page
 *  states the permission outcome instead of quietly rendering an empty chart. */
export const TECHNICIAN_SESSION = {
  user: {
    id: "development-technician",
    name: "Development Tech",
    email: "development.tech@laundrytwin.local"
  },
  source: "development",
  grants: [{ id: "development-technician-grant", role: "technician", branchId: "branch-fixture" }]
};

export type StubbedSession = "owner" | "technician";

export type StubbedOptions = {
  /** Session principal; defaults to the tenant-wide owner. */
  session?: StubbedSession;
  /** Extra `/api/*` responses, keyed by pathname. Overrides the defaults.
   *
   *  A value may be a function of the request URL, for the endpoints that are
   *  called more than once with different windows — the dashboard now fetches the
   *  prior period alongside the selected one, and a single static body would
   *  answer both with the same numbers. */
  responses?: Record<string, unknown | ((url: URL) => unknown)>;
  /** Status for a path in `responses`; defaults to 200. */
  statuses?: Record<string, number>;
};

/**
 * Install the fixture router. `analytics.pw.ts` uses `responses` to serve real
 * analytics payloads so the honesty labels can be asserted against a rendered
 * page rather than a unit helper.
 */
export async function installStubbedSession(page: Page, options: StubbedOptions = {}): Promise<void> {
  const session = options.session === "technician" ? TECHNICIAN_SESSION : DEVELOPMENT_OWNER_SESSION;
  const table: Record<string, unknown | ((url: URL) => unknown)> = {
    ...RESPONSES,
    "/api/me": session,
    ...(options.responses ?? {})
  };

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    // Exact path+query first, then the bare pathname. The analytics page picks
    // its own date range rather than reading one from the URL, so a fixture
    // keyed on a query string would never match a real request.
    const key = url.pathname + url.search in table ? url.pathname + url.search : url.pathname;
    if (key in table) {
      const status = options.statuses?.[key] ?? 200;
      const entry = table[key];
      const body = typeof entry === "function" ? entry(url) : entry;
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body)
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
