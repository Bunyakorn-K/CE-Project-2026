import { expect, test, type Page } from "@playwright/test";
import { EMPTY_WINDOW_MESSAGE } from "../src/lib/dashboard-view";
import { installStubbedSession } from "./support/session";

/**
 * The executive summary card, rendered against the real production bundle.
 *
 * The route existed, was RBAC-scoped and revenue-redacted, and had no browser
 * surface at all — so nothing in the UI could regress it. These cover the two
 * ways a summary card can lie: printing a confident sentence over a window that
 * was never measured, and disappearing without saying so when its source fails.
 */

const RANGE = "from=2026-08-01&to=2026-08-31";

function dashboardEnvelope(usageRowsInRange: number | null) {
  return {
    source: "clickhouse",
    fetchedAt: "2026-08-31T09:00:00.000Z",
    range: { from: "2026-08-01", to: "2026-08-31" },
    availability: "usage-derived",
    dashboard: {
      from: "2026-08-01",
      to: "2026-08-31",
      source: "clickhouse",
      usageRowsInRange,
      cycleAttribution: { countedRows: 100, attributedRows: 32, unattributedRows: 68 },
      totals: { revenueSatang: 1250000, cycles: 100, machines: 6, running: 2 },
      branches: [
        { branchId: "b1", branchName: "SYNTH-A", revenueSatang: 1250000, cycles: 100, machines: 6, running: 2 }
      ]
    }
  };
}

const summaryEnvelope = {
  source: "clickhouse",
  availability: "usage-derived",
  range: { from: "2026-08-01", to: "2026-08-31" },
  summary: "รอบรายงานนี้มี 100 รอบ จาก 6 เครื่อง · ยอดชำระสำเร็จ ฿12,500.00 · ข้อมูลสดไม่พร้อม 6 เครื่อง.",
  generatedBy: "deterministic-reporting-v1",
  generatedAt: "2026-08-31T09:00:00.000Z"
};

const card = (page: Page) => page.locator('section[aria-label="สรุปสำหรับผู้บริหาร"]');

async function openDashboard(
  page: Page,
  responses: Record<string, unknown> = {},
  statuses?: Record<string, number>
): Promise<void> {
  await installStubbedSession(page, { responses, statuses });
  await page.goto(`/dashboard?${RANGE}`);
  await page.locator(".app-topbar").waitFor({ state: "visible" });
}

test.describe("executive summary card", () => {
  test("shows the sentence with the provenance that produced it", async ({ page }) => {
    await openDashboard(page, {
      "/api/report/dashboard": dashboardEnvelope(100),
      "/api/report/summary": summaryEnvelope
    });

    const summary = card(page);
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("รอบรายงานนี้มี 100 รอบ");
    // "Live telemetry" would be the one label that would make an executive
    // treat a usage-derived count as a machine reading.
    await expect(summary).toContainText("ไม่ใช่ live telemetry");
    await expect(summary).not.toContainText("ไม่พร้อมใช้งาน");
  });

  test("prints no summary at all over an empty window", async ({ page }) => {
    await openDashboard(page, {
      "/api/report/dashboard": dashboardEnvelope(0),
      // The server would still answer with "0 cycles from 0 machines". Rendered
      // next to real KPIs, that reads as a finding about the branch.
      "/api/report/summary": { ...summaryEnvelope, summary: "รอบรายงานนี้มี 0 รอบ จาก 0 เครื่อง." }
    });

    await expect(card(page)).toHaveCount(0);
    // The window message stays: hiding the summary must not hide the reason.
    await expect(page.locator(".state-message").filter({ hasText: EMPTY_WINDOW_MESSAGE })).toBeVisible();
  });

  test("states that the summary is unavailable rather than omitting it", async ({ page }) => {
    await openDashboard(page, { "/api/report/dashboard": dashboardEnvelope(100) }, { "/api/report/summary": 503 });

    await expect(card(page)).toHaveCount(0);
    // Silence would read as "nothing to summarise", which is a different claim
    // from "the source could not answer".
    await expect(page.locator(".state-message").filter({ hasText: "สรุปผู้บริหารไม่พร้อมใช้งาน" })).toBeVisible();
  });

  test("never labels an unnamed summary source as real data", async ({ page }) => {
    await openDashboard(page, {
      "/api/report/dashboard": dashboardEnvelope(100),
      "/api/report/summary": { ...summaryEnvelope, source: null, availability: null }
    });

    const summary = card(page);
    await expect(summary).toContainText("แหล่งข้อมูล: ไม่ทราบ");
    await expect(summary).not.toContainText("ข้อมูลจริง");
  });
});