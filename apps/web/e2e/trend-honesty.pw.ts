import { expect, test, type Page } from "@playwright/test";
import { installStubbedSession } from "./support/session";
import { TREND_EMPTY_MESSAGE, TREND_GAP_NOTE, TREND_UNAVAILABLE_MESSAGE } from "../src/lib/dashboard-trend";

/**
 * The daily trend chart, rendered against the real production bundle.
 *
 * A chart is the easiest thing on this dashboard to make lie, because every way
 * of getting it wrong produces pixels: a missing day filled with a zero reads as
 * a collapse in trade, a withheld revenue series drawn at zero reads as a branch
 * that took no money, and a source that cannot measure at all reads as a flat
 * line at the bottom. All three look like a working chart. So these assert the
 * states that have NO chart in them, and the one place a gap must break the line.
 */

const RANGE = "from=2026-08-27&to=2026-08-31";

const TREND_POINT = (date: string, cycles: number, revenueSatang: number) => ({
  date,
  revenueSatang,
  cycles,
  usageRows: cycles
});

function envelope(overrides: Record<string, unknown>, usageRowsInRange: number | null = 100) {
  return {
    source: "clickhouse",
    fetchedAt: "2026-08-31T09:00:00.000Z",
    range: { from: "2026-08-27", to: "2026-08-31" },
    availability: "usage-derived",
    dashboard: {
      from: "2026-08-27",
      to: "2026-08-31",
      source: "clickhouse",
      usageRowsInRange,
      cycleAttribution: { countedRows: 100, attributedRows: 32, unattributedRows: 68 },
      totals: { revenueSatang: 1250000, cycles: 100, machines: 6, running: 2 },
      branches: [
        { branchId: "b1", branchName: "SYNTH-A", revenueSatang: 1250000, cycles: 100, machines: 6, running: 2 }
      ],
      trend: [
        TREND_POINT("2026-08-27", 15, 187500),
        TREND_POINT("2026-08-28", 20, 250000),
        TREND_POINT("2026-08-29", 30, 375000),
        TREND_POINT("2026-08-30", 25, 312500),
        TREND_POINT("2026-08-31", 25, 312500)
      ],
      ...overrides
    }
  };
}

async function openDashboard(page: Page, overrides: Record<string, unknown> = {}, usageRows: number | null = 100) {
  await installStubbedSession(page, { responses: { "/api/report/dashboard": envelope(overrides, usageRows) } });
  await page.goto(`/dashboard?${RANGE}`);
  await page.locator(".trend-card").waitFor({ state: "visible" });
}

const chart = (page: Page) => page.locator(".trend-svg");
const trendCard = (page: Page) => page.locator(".trend-card");

test.describe("the daily trend draws only what was measured", () => {
  test("renders one line across a fully measured window", async ({ page }) => {
    await openDashboard(page);

    await expect(chart(page)).toBeVisible();
    // Five measured days, one segment, no gaps.
    await expect(page.locator(".trend-line")).toHaveCount(1);
    await expect(page.locator(".trend-gap")).toHaveCount(0);
    await expect(page.locator(".trend-note")).toHaveCount(0);
    // Each day is reachable: a 3px dot is not a target, so the overlay columns
    // are what actually carry the values.
    await expect(page.locator(".trend-day")).toHaveCount(5);
  });

  // THE gap rule. AGENTS.md records 2026-07-27 as a genuine source gap, so a
  // zero there would draw a dip to nothing on the one day the warehouse cannot
  // speak about — which reads as the worst day of the month.
  //
  // The window is five days rather than four so that BOTH sides of the gap are
  // runs of two or more. A four-day window with 08-29 dropped leaves a leading
  // run of one, which the geometry correctly draws as a DOT, and the assertion
  // then fails on `.trend-line` for a reason that has nothing to do with the gap
  // rule. The first version of this spec made exactly that mistake.
  test("breaks the line at a day with no row instead of dipping to zero", async ({ page }) => {
    await openDashboard(page, {
      trend: [
        TREND_POINT("2026-08-27", 15, 187500),
        TREND_POINT("2026-08-28", 20, 250000),
        // 2026-08-29 has no entry at all.
        TREND_POINT("2026-08-30", 25, 312500),
        TREND_POINT("2026-08-31", 25, 312500)
      ]
    });

    // Two runs of consecutive days, not one joined line.
    await expect(page.locator(".trend-line")).toHaveCount(2);
    await expect(page.locator(".trend-gap")).toHaveCount(1);
    // And the break is explained, or it reads as a rendering bug.
    await expect(page.locator(".trend-note")).toHaveText(TREND_GAP_NOTE);
    // The gap day is still ON the axis — omitted would hide the discontinuity,
    // zero-filled would invent a value.
    await expect(page.locator(".trend-day")).toHaveCount(5);
    await expect(page.locator(".trend-day svg").nth(2)).toHaveAttribute("aria-label", /ไม่มีแถว usage ที่รายงาน/);
  });

  test("says a source that cannot report a trend is unavailable, not empty", async ({ page }) => {
    // The demo/IRIS path returns `trend: null` — a source with no per-day field.
    await openDashboard(page, { trend: null });

    await expect(chart(page)).toHaveCount(0);
    await expect(page.locator(".trend-placeholder")).toHaveText(TREND_UNAVAILABLE_MESSAGE);
  });

  test("says an empty window has no daily data rather than drawing a flat line", async ({ page }) => {
    // Asked and got nothing — a measurement, unlike `null`.
    await openDashboard(page, { trend: [] });

    await expect(chart(page)).toHaveCount(0);
    await expect(page.locator(".trend-placeholder")).toHaveText(TREND_EMPTY_MESSAGE);
  });
});

test.describe("revenue redaction holds through the chart", () => {
  test("draws no revenue line and offers no revenue switch to a technician", async ({ page }) => {
    await installStubbedSession(page, {
      session: "technician",
      responses: {
        "/api/report/dashboard": envelope({
          // What the API actually returns after `redactDashboardDataRevenue`:
          // the series is present, and every revenue value on it is null.
          totals: { revenueSatang: null, cycles: 100, machines: 6, running: 2 },
          trend: [
            { date: "2026-08-27", revenueSatang: null, cycles: 15, usageRows: 15 },
            { date: "2026-08-28", revenueSatang: null, cycles: 20, usageRows: 20 },
            { date: "2026-08-29", revenueSatang: null, cycles: 30, usageRows: 30 },
            { date: "2026-08-30", revenueSatang: null, cycles: 25, usageRows: 25 },
            { date: "2026-08-31", revenueSatang: null, cycles: 25, usageRows: 25 }
          ]
        })
      }
    });
    await page.goto(`/dashboard?${RANGE}`);
    await trendCard(page).waitFor({ state: "visible" });

    // The cycle series is measured for every grant, so it still draws.
    await expect(chart(page)).toBeVisible();
    await expect(page.locator(".trend-line")).toHaveCount(1);
    // The revenue control is disabled rather than offered and empty: a switch
    // whose every value is missing reads as a broken control, not a boundary.
    const revenueSwitch = page.locator(".trend-metric-switch button", { hasText: "รายได้" });
    await expect(revenueSwitch).toBeDisabled();
  });

  // A null on the daily series must never reach the screen as a number.
  //
  // The technician case above cannot prove that: its revenue switch is disabled,
  // so the revenue axis is never rendered and no assertion about it can fail.
  // Two earlier versions of this spec therefore passed against a mutation that
  // coerced every null revenue to a real zero — once asserting the axis did not
  // read "฿0", once asserting the card contained no "฿" at all. Both were
  // theatre: the revenue metric was never selected, so neither could fail.
  //
  // This one renders the revenue series for an OWNER, and withholds the money
  // only on the daily points — the mismatch the web must survive, because the
  // totals and the series are produced by the same redaction but a partial
  // series, a source that reports cycles without amounts, or an older API build
  // can disagree. Under the coercion mutation this axis reads ฿0 at every tick.
  test("draws no money where the daily series has none, even for an owner", async ({ page }) => {
    await installStubbedSession(page, {
      responses: {
        "/api/report/dashboard": envelope({
          // The owner may see revenue, so the switch is live…
          totals: { revenueSatang: 1250000, cycles: 100, machines: 6, running: 2 },
          // …but no day of the series carries an amount.
          trend: [
            { date: "2026-08-27", revenueSatang: null, cycles: 15, usageRows: 15 },
            { date: "2026-08-28", revenueSatang: null, cycles: 20, usageRows: 20 },
            { date: "2026-08-29", revenueSatang: null, cycles: 30, usageRows: 30 },
            { date: "2026-08-30", revenueSatang: null, cycles: 25, usageRows: 25 },
            { date: "2026-08-31", revenueSatang: null, cycles: 25, usageRows: 25 }
          ]
        })
      }
    });
    await page.goto(`/dashboard?${RANGE}`);
    await trendCard(page).waitFor({ state: "visible" });

    const revenueSwitch = page.locator(".trend-metric-switch button", { hasText: "รายได้" });
    await expect(revenueSwitch).toBeEnabled();
    await revenueSwitch.click();

    // No amount anywhere: no line, no ฿0 tick, no "รวม ฿0" caption. A zero here
    // is a claim that the branch took no money on a day nobody measured.
    // Not an axis at zero — that would assert the branch took no money on days
    // nobody measured — and not an empty frame either, which reads the same way.
    await expect(page.locator(".trend-axis--y")).toHaveCount(0);
    await expect(page.locator(".trend-line")).toHaveCount(0);
    await expect(trendCard(page)).not.toContainText("฿");
    await expect(page.locator(".trend-placeholder")).toContainText("รายได้ไม่พร้อมใช้งาน");
  });

  // The counterpart, so the assertion above is not passing because the revenue
  // axis is inert: a real amount DOES reach the axis, in baht and not satang.
  test("plots a real amount in baht on the revenue axis", async ({ page }) => {
    await openDashboard(page);
    await page.locator(".trend-metric-switch button", { hasText: "รายได้" }).click();

    await expect(page.locator(".trend-line")).toHaveCount(1);

    // The peak day carries 375,000 satang, so the units must be proven twice:
    // the axis and the caption must both read BAHT, and the satang figure must
    // appear in neither. An axis reading "375,000" would be satang labelled as
    // baht — off by a factor of 100.
    //
    // An earlier version asserted the axis read exactly ฿3,750, which was the
    // PEAK rather than the axis. It passed only because the ceiling happened to
    // land on the peak, and broke as soon as the ceiling was rounded up to a
    // whole ฿1,000 step above it — a change that made the axis more readable and
    // failed a correct test. What has to be true is that the gridlines are whole
    // baht and the peak is the figure the caption names.
    const axis = page.locator(".trend-axis--y");
    const ticks = axis.locator(".trend-axis-label");
    await expect(ticks).toHaveText(["฿4,000", "฿3,000", "฿2,000", "฿1,000", "฿0"]);
    await expect(axis).not.toContainText("375,000");
    await expect(page.locator(".trend-caption")).toContainText("สูงสุด ฿3,750");
    await expect(page.locator(".trend-caption")).not.toContainText("375,000");
  });
});

test.describe("the chart is readable rather than merely drawn", () => {
  test("states the series in text with the peak day named", async ({ page }) => {
    await openDashboard(page);

    const caption = page.locator(".trend-caption");
    await expect(caption).toBeVisible();
    await expect(caption).toContainText("สูงสุด");
    await expect(caption).toContainText("2026-08-29");
    await expect(caption).toContainText("5 วันที่มีข้อมูล");
    // The average is qualified, or a gap day would be counted as a low one.
    await expect(caption).toContainText("ต่อวันที่มีข้อมูล");
  });

  test("labels the first and last day of the window only", async ({ page }) => {
    await openDashboard(page);

    const labels = page.locator(".trend-axis--x .trend-axis-label");
    await expect(labels).toHaveCount(2);
    // Thai short date, no year — the range is stated in the card header above.
    await expect(labels.first()).toContainText("27");
    await expect(labels.first()).not.toContainText("2026");
  });

  // The plot's marks must land ON the plot box, and this is the one defect in
  // the chart that every count-based assertion here passed straight through.
  //
  // The marks SVG set its `viewBox` to start at the plot's left padding while
  // the points inside were ALSO offset by that padding, so the offset was
  // applied twice: the first point rendered ~97px to the left of the y-axis
  // labels, and the series hung outside its own frame. Nothing about the DOM was
  // wrong — the elements, the counts, the labels, the caption and the note all
  // asserted green while the chart was visibly broken. Only geometry sees it.
  test("draws the series inside the plot box at both widths", async ({ page }) => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await openDashboard(page);

      const boxes = await page.evaluate(() => {
        const svg = document.querySelector(".trend-svg")!.getBoundingClientRect();
        const lines = Array.from(document.querySelectorAll(".trend-line")).map((line) =>
          line.getBoundingClientRect()
        );
        return {
          plot: { left: svg.left, right: svg.right },
          first: Math.min(...lines.map((box) => box.left)),
          last: Math.max(...lines.map((box) => box.right))
        };
      });

      // The first measured day reaches the plot's left edge and the last its
      // right. The tolerance covers the stroke, which overhangs each end by
      // about a pixel; the defect being guarded was 97.
      expect(boxes.first).toBeGreaterThan(boxes.plot.left - 3);
      expect(boxes.last).toBeLessThan(boxes.plot.right + 3);
    }
  });

  test("fits a phone viewport without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDashboard(page);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // The switch wraps under the heading rather than squeezing it.
    await expect(page.locator(".trend-metric-switch")).toBeVisible();
  });
});