import { expect, test, type Page } from "@playwright/test";
import { installStubbedSession } from "./support/session";

/**
 * The Digital Twin floor must not draw a machine into a state its own card
 * disclaims.
 *
 * Each card used to carry a 116×96px SVG drum that encoded exactly two bits —
 * running or not, and washer or dryer — both of which the status and kind pills
 * on the same card already state in words. It was the largest element on the
 * card and it read from `status` alone, so a machine whose freshness is
 * `unavailable` was drawn with the same live teal wave and running glass as a
 * fresh one. The picture asserted "running now" on a card whose own pills said
 * `ไม่พร้อมใช้งาน`. Decoration that contradicts the text beside it is worse
 * than no decoration.
 */

const WASHERS = [
  { machineCode: "W-01", machineKind: "washer", branchName: "SYNTH-A", status: "running", lastActiveAt: "2026-08-31T08:59:00.000Z", cycleCount: 12, cycleCountSource: "usage_row", freshness: "fresh" },
  // Same `running` status, but the evidence is a week old and the API says so.
  { machineCode: "W-02", machineKind: "washer", branchName: "SYNTH-A", status: "running", lastActiveAt: "2026-08-25T08:59:00.000Z", cycleCount: 0, cycleCountSource: "usage_row", freshness: "unavailable" },
  { machineCode: "W-03", machineKind: "washer", branchName: "SYNTH-A", status: "offline", lastActiveAt: null, cycleCount: null, cycleCountSource: "unavailable", freshness: "unavailable" }
];

const DRYERS = [
  { machineCode: "D-01", machineKind: "dryer", branchName: "SYNTH-A", status: "drying", lastActiveAt: "2026-08-31T08:58:00.000Z", cycleCount: 8, cycleCountSource: "usage_row", freshness: "fresh" }
];

async function openTwin(page: Page): Promise<void> {
  await installStubbedSession(page, {
    responses: {
      "/api/twin": {
        source: "clickhouse",
        fetchedAt: "2026-08-31T09:00:00.000Z",
        range: { from: "2026-08-01", to: "2026-08-31" },
        availability: "usage-derived",
        from: "2026-08-01",
        to: "2026-08-31",
        machines: [...WASHERS, ...DRYERS]
      }
    }
  });
  await page.goto("/dashboard?view=twin");
  await page.locator(".machine-floor-card").first().waitFor({ state: "visible" });
}

function cardFor(page: Page, code: string) {
  return page.locator(".machine-floor-card").filter({ hasText: code });
}

test.describe("the twin floor does not draw a state it disclaims", () => {
  test("renders no machine illustration at all", async ({ page }) => {
    await openTwin(page);

    // The illustration encoded running/offline and washer/dryer — four cards,
    // two states, and every one of them already in the pills beside it. The
    // shell's own icons (sort chevron, tab markers) are legitimate svg and are
    // deliberately not asserted on here.
    await expect(page.locator(".machine-drum")).toHaveCount(0);
    await expect(page.locator(".machine-floor-visual")).toHaveCount(0);
    await expect(page.locator(".machine-floor-card svg")).toHaveCount(0);
  });

  test("states status and evidence age in words on every card", async ({ page }) => {
    await openTwin(page);

    for (const machine of [...WASHERS, ...DRYERS]) {
      const card = cardFor(page, machine.machineCode);
      await expect(card).toHaveCount(1);
      // The status is named, not only coloured.
      await expect(card).toContainText(
        machine.status === "running" ? "กำลังใช้งาน" : machine.status === "drying" ? "กำลังอบ" : "ออฟไลน์"
      );
      // And the evidence age is named separately, so a week-old `running`
      // cannot be read as a live one.
      await expect(card).toContainText(
        machine.freshness === "fresh" ? "สดตามแหล่งข้อมูล" : "ไม่พร้อมใช้งาน"
      );
    }
  });

  test("does not show a cycle count for a machine with no usage rows", async ({ page }) => {
    await openTwin(page);

    // W-03 has no last activity at all, so there is nothing to count from.
    await expect(cardFor(page, "W-03")).toContainText("ไม่พร้อมใช้งาน");
    await expect(cardFor(page, "W-03")).toContainText("ไม่มีแถว usage ในช่วงนี้");
    // W-02's zero is real and stays a zero — it is not "unavailable".
    await expect(cardFor(page, "W-02")).toContainText("นับจากแถว usage");
  });

  test("gives each card a compact height now that the illustration is gone", async ({ page }) => {
    await openTwin(page);

    // The illustration was a 96px drawing inside a well with `min-height: 118px`
    // plus 14px of margin above and 10px below — 142px of card that carried no
    // fact. With it gone the card is 328px of text, so a ceiling of 400 separates
    // the two and would catch the well returning.
    const box = await cardFor(page, "W-01").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThan(400);
  });
});
