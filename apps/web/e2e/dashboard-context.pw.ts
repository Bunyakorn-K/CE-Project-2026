import { expect, test, type Page } from "@playwright/test";
import { installStubbedSession } from "./support/session";

/**
 * The dashboard's working context, rendered against the real production bundle.
 *
 * The route carried all view state in `useState`, so the context was
 * unrecoverable and unshareable — and `dashboard.pw.ts` was already navigating
 * to `/dashboard?from=…&to=…` against a route that ignored those params, so the
 * fixture setup was asserting nothing at all. These cover the four surfaces the
 * critique raised: URL state, presets, the branch sort, and the prior-period
 * comparison.
 */

const RANGE = "from=2026-08-01&to=2026-08-31";

const BRANCHES = [
  { branchId: "b3", branchName: "SYNTH-C", revenueSatang: 300_000, cycles: 30, machines: 4, running: 1 },
  { branchId: "b1", branchName: "SYNTH-A", revenueSatang: 900_000, cycles: 90, machines: 4, running: 3 },
  { branchId: "b2", branchName: "SYNTH-B", revenueSatang: null, cycles: 60, machines: 4, running: 2 }
];

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    source: "clickhouse",
    fetchedAt: "2026-08-31T09:00:00.000Z",
    range: { from: "2026-08-01", to: "2026-08-31" },
    availability: "usage-derived",
    dashboard: {
      from: "2026-08-01",
      to: "2026-08-31",
      source: "clickhouse",
      usageRowsInRange: 180,
      cycleAttribution: { countedRows: 180, attributedRows: 180, unattributedRows: 0 },
      totals: { revenueSatang: 1_200_000, cycles: 180, machines: 12, running: 6 },
      branches: BRANCHES,
      ...overrides
    }
  };
}

async function openDashboard(
  page: Page,
  responses: Record<string, unknown> = {},
  query = `?${RANGE}`
): Promise<void> {
  await installStubbedSession(page, {
    responses: { "/api/report/dashboard": envelope(), ...responses }
  });
  await page.goto(`/dashboard${query}`);
  await page.locator(".app-topbar").waitFor({ state: "visible" });
}

test.describe("dashboard working context", () => {
  test("reads the range from the URL instead of ignoring it", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/report/dashboard")) requested.push(request.url());
    });

    await openDashboard(page);

    // The fixture navigated with this range and the route discarded it, so the
    // request used the 7-day default instead.
    expect(requested.some((url) => url.includes("from=2026-08-01") && url.includes("to=2026-08-31"))).toBe(true);
  });

  test("shows the range from the URL in the date inputs", async ({ page }) => {
    await openDashboard(page);

    await expect(page.locator("#dashboard-from")).toHaveValue("2026-08-01");
    await expect(page.locator("#dashboard-to")).toHaveValue("2026-08-31");
  });

  test("opens the Digital Twin when the URL names it", async ({ page }) => {
    await openDashboard(
      page,
      {
        "/api/twin": {
          source: "clickhouse",
          fetchedAt: "2026-08-31T09:00:00.000Z",
          range: { from: "2026-08-01", to: "2026-08-31" },
          availability: "usage-derived",
          from: "2026-08-01",
          to: "2026-08-31",
          machines: [
            { machineCode: "W-01", machineKind: "washer", branchName: "SYNTH-A", status: "running", lastActiveAt: "2026-08-31T08:59:00.000Z", cycleCount: 12, cycleCountSource: "usage_row", freshness: "fresh" }
          ]
        }
      },
      "?view=twin"
    );

    // Only the Twin query runs in this view, so its card appearing proves the
    // URL chose the tab rather than the component defaulting to the dashboard.
    await expect(page.locator(".machine-floor-card").first()).toBeVisible();
    await expect(page.locator(".kpi-grid")).toHaveCount(0);
  });

  test("rejects an impossible range from the URL rather than querying it", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/report/dashboard")) requested.push(request.url());
    });

    await openDashboard(page, {}, "?from=2026-02-31&to=2026-08-31");

    await expect(page.locator(".error-message").first()).toBeVisible();
    expect(requested.some((url) => url.includes("2026-02-31"))).toBe(false);
  });

  test("sorts the branch grid without changing what is queried", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/report/dashboard")) requested.push(request.url());
    });

    await openDashboard(page);

    await expect(page.locator(".branch-card h3")).toHaveText(["SYNTH-A", "SYNTH-B", "SYNTH-C"]);

    await page.locator("#branch-sort").selectOption("cycles");
    await expect(page.locator(".branch-card h3")).toHaveText(["SYNTH-A", "SYNTH-B", "SYNTH-C"]);

    const afterSort = requested.length;
    await page.locator("#branch-sort").selectOption("revenue");
    // A redacted branch sorts last rather than as zero.
    await expect(page.locator(".branch-card h3")).toHaveText(["SYNTH-A", "SYNTH-C", "SYNTH-B"]);
    expect(requested.length).toBe(afterSort);
  });

  test("states the prior window a delta is measured against", async ({ page }) => {
    await installStubbedSession(page, {
      responses: {
        "/api/report/dashboard": (url: URL) =>
          url.searchParams.get("from") === "2026-07-01"
            ? envelope({
                totals: { revenueSatang: 1_000_000, cycles: 100, machines: 12, running: 6 },
                usageRowsInRange: 100
              })
            : envelope()
      }
    });
    await page.goto(`/dashboard?${RANGE}`);
    await page.locator(".comparison-strip").waitFor({ state: "visible" });

    // "฿48,200 down 18% from the prior 7 days" is a finding; the bare number is
    // not. The named prior window is what stops the delta reading as a forecast.
    // Thai output is Buddhist-era, so the expected text is 1–31 ก.ค. 2569.
    await expect(page.locator(".comparison-basis")).toContainText("1 ก.ค. 2569");
    await expect(page.locator(".comparison-basis")).toContainText("31 ก.ค. 2569");
    // 180 cycles against 100 prior, and ฿12,000 against ฿10,000.
    await expect(page.locator(".comparison-delta").first()).toBeVisible();
    await expect(page.locator(".comparison-delta--up")).toHaveCount(2);
  });

  test("says the comparison is unavailable instead of omitting it", async ({ page }) => {
    await installStubbedSession(page, {
      responses: {
        // The prior window is empty, so it has no cycles and no revenue to
        // compare against. A percentage against a zero prior is undefined, and
        // rendering nothing at all would read as "no change".
        "/api/report/dashboard": (url: URL) =>
          url.searchParams.get("from") === "2026-07-01"
            ? envelope({ totals: { revenueSatang: 0, cycles: 0, machines: 12, running: 0 }, usageRowsInRange: 0 })
            : envelope()
      }
    });
    await page.goto(`/dashboard?${RANGE}`);
    await page.locator(".app-topbar").waitFor({ state: "visible" });

    await expect(page.locator(".comparison-strip")).toBeVisible();
    await expect(page.locator(".comparison-note").first()).toContainText("ไม่มียอดในช่วงก่อนหน้าให้เทียบ");
    await expect(page.locator(".comparison-delta")).toHaveCount(0);
  });

  test("offers date presets that write the URL", async ({ page }) => {
    await openDashboard(page);

    // "7 วัน" is the default window, so it is deliberately absent from the URL —
    // the common case stays short. "30 วัน" is a real change and must be written.
    await page.locator('.range-presets button', { hasText: "30 วัน" }).click();

    // 30 days back from today; `to` is today, which is already the default and
    // is therefore omitted rather than repeated.
    await expect(page).toHaveURL(/\?from=\d{4}-\d{2}-\d{2}$/);
    await expect(page.locator("#dashboard-from")).not.toHaveValue("");
    await expect(page.locator('.range-presets button[aria-pressed="true"]')).toHaveText("30 วัน");
  });
});