import { expect, test, type Page } from "@playwright/test";
import { gotoAuthenticated, installStubbedSession } from "./support/session";

/**
 * Rendering assertions for the analytics page.
 *
 * `layout.pw.ts` measures the shell and never reads a value off the page. That
 * left the page's most important behaviour untested in a browser: the honesty
 * labels. A unit test proves `sourceLabel("unverifiable")` returns a string; it
 * does not prove the weather section ever passes that tag, and a regression
 * that routed the weather response through the generic envelope would render
 * "ข้อมูลจริง" on a page with no way to notice.
 *
 * These run against the real production bundle with the API stubbed, so they
 * need no API process, no ClickHouse and no SQLite.
 */

const RANGE = "from=2026-08-01&to=2026-08-31";

const envelope = (meta: Record<string, unknown>, data: unknown[]) => ({ meta, data });

const baseMeta = {
  range: { from: "2026-08-01", to: "2026-08-31" },
  branchId: null
};

const OFF_PEAK_ROWS = [
  { rank: 1, dayOfWeek: 1, weekday: "Mon", hourOfDay: 3, branchId: "b1", branchName: "SYNTH-A", cycles: 2, totalDurationMin: 60 },
  { rank: 2, dayOfWeek: 7, weekday: "Sun", hourOfDay: 23, branchId: "b1", branchName: "SYNTH-A", cycles: 4, totalDurationMin: 120 }
];

async function openAnalytics(
  page: Page,
  options: Parameters<typeof installStubbedSession>[1] = {}
): Promise<void> {
  await installStubbedSession(page, options);
  await page.goto(`/analytics?${RANGE}`);
  await page.locator(".app-topbar").waitFor({ state: "visible" });
}

function section(page: Page, heading: string) {
  return page.locator(".analytics-section").filter({ has: page.getByRole("heading", { name: heading }) });
}

test.describe("analytics page rendering", () => {
  test("shows the off-peak rules that produced the ranking", async ({ page }) => {
    await openAnalytics(page, {
      responses: {
        ["/api/v1/analytics/off-peak"]: envelope(
          {
            ...baseMeta,
            dataSource: "real",
            method: "offpeak_percentile",
            rules: { minCycles: 10, percentile: 25, eligibleBuckets: 24, returnedBuckets: 2 },
            caveats: ["buckets are Asia/Bangkok local hours (UTC+7, no DST)"]
          },
          OFF_PEAK_ROWS
        )
      }
    });

    const card = section(page, "ช่วงเวลาที่ไม่หนาแน่น");
    await expect(card).toBeVisible();
    await expect(card).toContainText("03:00–04:00");
    // Midnight must wrap rather than render as a 24th hour.
    await expect(card).toContainText("23:00–00:00");
    // The server caveat is the only thing that says which timezone the buckets
    // are in, so it has to survive into the page.
    await expect(card).toContainText("UTC+7");
  });

  test("explains an empty ranking by the rule that emptied it", async ({ page }) => {
    await openAnalytics(page, {
      responses: {
        ["/api/v1/analytics/off-peak"]: envelope(
          { ...baseMeta, dataSource: "empty", rules: { minCycles: 10, percentile: 25, eligibleBuckets: 0, returnedBuckets: 0 } },
          []
        )
      }
    });

    const card = section(page, "ช่วงเวลาที่ไม่หนาแน่น");
    await expect(card).toContainText("10");
    // "no off-peak time" and "not enough data to say" are different findings.
    await expect(card).not.toContainText("ไม่มีช่วงเวลาที่ตรงเกณฑ์ในช่วงวันที่ที่เลือก");
  });

  test("never labels a weather window as verified real", async ({ page }) => {
    await openAnalytics(page, {
      responses: {
        ["/api/v1/analytics/weather/usage"]: envelope(
          {
            ...baseMeta,
            dataSource: "unverifiable",
            caveats: ["Provenance unverifiable: fact_weather_sample has no synthetic/provenance marker column"]
          },
          [{ date: "2026-08-01", branchName: "SYNTH-A", cycles: 20, avgTempC: 30.4, avgHumidityPct: 71, totalRainMm: 0, missingTemp: 0 }]
        )
      }
    });

    const card = section(page, "อากาศและรอบซัก");
    await expect(card).toBeVisible();
    await expect(card).toContainText("ตรวจสอบแหล่งที่มาไม่ได้");
    // The whole point of the unverifiable tag. If this ever appears, the
    // weather response is no longer going through weatherDataSource.
    await expect(card).not.toContainText("ข้อมูลจริง");
    await expect(card).toContainText("Provenance unverifiable");
  });

  test("renders a missing temperature as unknown, not as zero degrees", async ({ page }) => {
    await openAnalytics(page, {
      responses: {
        ["/api/v1/analytics/weather/usage"]: envelope(
          { ...baseMeta, dataSource: "unverifiable", caveats: [] },
          [{ date: "2026-08-02", branchName: "SYNTH-A", cycles: 8, avgTempC: null, avgHumidityPct: null, totalRainMm: null, missingTemp: 24 }]
        )
      }
    });

    const card = section(page, "อากาศและรอบซัก");
    await expect(card).toContainText("ไม่ทราบ");
    await expect(card).not.toContainText("0.0°C");
  });

  test("tells a technician it has no revenue access and does not request any", async ({ page }) => {
    const revenueCalls: string[] = [];
    await openAnalytics(page, { session: "technician" });
    page.on("request", (request) => {
      if (request.url().includes("/analytics/revenue/")) revenueCalls.push(request.url());
    });

    const card = section(page, "รายได้รายวัน");
    await expect(card).toContainText("ไม่มีสิทธิ์ดูรายได้");
    // The server would reject it anyway; the page must not waste the call or
    // render an empty chart that reads like "no revenue this period".
    expect(revenueCalls).toEqual([]);
  });
});
