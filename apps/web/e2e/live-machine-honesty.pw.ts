import { expect, test, type Page } from "@playwright/test";
import { installStubbedSession } from "./support/session";

/**
 * The live machine page must not assert a machine state its own card disclaims.
 *
 * Measured on production on 2026-10-01: 19 machines at the real branch, of which
 * 17 reported a `running` or `finished` status with freshness `unavailable`.
 * Every one of those 17 rendered the status in a green `status-pill--success`
 * pill, directly above a red `ไม่พร้อมใำงาน` freshness pill two rows below. The
 * loudest element on the card asserted a live machine state that the card itself
 * said it had no evidence for.
 *
 * This is the same defect class the twin page already fixed by removing its
 * machine illustration. The twin's fix left the page's own guard as the only
 * thing holding; the live page never had one, so the unit test on
 * `liveStatusClaim` is not sufficient — this renders the built bundle and reads
 * the classes the browser actually paints.
 */

const LIVE_REASON = "Digital Twin state is derived from usage data; live telemetry is unavailable";

function machine(overrides: Record<string, unknown>) {
  return {
    id: `machine-${Math.random().toString(36).slice(2)}`,
    code: "W1",
    kind: "washer",
    configuredStatus: "active",
    state: "running",
    remainingSeconds: null,
    lastSeen: "2026-10-01 09:49:59.373",
    freshness: "unavailable",
    reason: "No recent usage evidence is available for this machine",
    coverage: { liveState: { available: false, reason: LIVE_REASON } },
    ...overrides
  };
}

/** The three production pairs, plus a fresh control. */
const MACHINES = [
  machine({ code: "D1", kind: "dryer", state: "running", freshness: "stale", reason: "Usage data is older than 30 minutes" }),
  machine({ code: "D9", kind: "dryer", state: "running", freshness: "unavailable" }),
  machine({ code: "W4", kind: "washer", state: "finished", freshness: "unavailable" }),
  machine({ code: "W7", kind: "washer", state: "running", freshness: "fresh", reason: undefined })
];

async function openMachines(page: Page, machines = MACHINES): Promise<void> {
  await installStubbedSession(page, {
    responses: {
      "/api/report/branches": { branches: [{ id: "branch-fixture", name: "Fixture Branch", status: "active" }] },
      "/api/report/live": {
        live: {
          contractVersion: "clickhouse-usage-derived",
          source: "clickhouse",
          fetchedAt: "2026-10-01T09:57:41.321Z",
          branchId: "branch-fixture",
          machines
        }
      }
    }
  });
  await page.goto("/machines");
  await page.locator(".machine-card").first().waitFor({ state: "visible" });
}

function cardFor(page: Page, code: string) {
  return page.locator(".machine-card").filter({ hasText: code });
}

/** The status pill in a card's head — the claim, not the freshness row. */
function statusPill(card: ReturnType<typeof cardFor>) {
  return card.locator(".machine-card-head .status-pill");
}

test.describe("the live machine page claims only what its evidence supports", () => {
  test("never paints a machine in a success colour while its freshness is unavailable", async ({ page }) => {
    await openMachines(page);

    for (const code of ["D9", "W4"]) {
      const pill = statusPill(cardFor(page, code));
      // The regression itself: `running` + `unavailable` was a green pill.
      await expect(pill).not.toHaveClass(/status-pill--success/);
      await expect(pill).toContainText("ไม่ทราบสถานะปัจจุบัน");
      // And the freshness pill beside it still says what it always said.
      await expect(cardFor(page, code)).toContainText("ไม่พร้อมใช้งาน");
    }
  });

  test("keeps the withheld machine's last recorded state visible as history", async ({ page }) => {
    await openMachines(page);

    // A card reading only "unknown" would make a technician re-check a machine
    // the card can already answer. The history is stated; the headline is not.
    await expect(cardFor(page, "D9")).toContainText("บันทึกล่าสุดว่า กำลังใช้งาน");
    await expect(cardFor(page, "W4")).toContainText("บันทึกล่าสุดว่า จบรอบแล้ว");
  });

  test("does not let a stale machine's state read as live either", async ({ page }) => {
    await openMachines(page);

    // Stale is real evidence, so the state is kept — but `stale` must not wear
    // the success colour, and the label must be in the past tense.
    const pill = statusPill(cardFor(page, "D1"));
    await expect(pill).not.toHaveClass(/status-pill--success/);
    await expect(pill).toContainText("สถานะล่าสุด:");
    await expect(pill).toContainText("กำลังใช้งาน");
    await expect(cardFor(page, "D1")).toContainText("ข้อมูลไม่สด");
  });

  test("still states a fresh machine's state plainly", async ({ page }) => {
    await openMachines(page);

    // The control. Without it, a fix that simply suppressed every state would
    // pass the three tests above.
    const pill = statusPill(cardFor(page, "W7"));
    await expect(pill).toHaveClass(/status-pill--success/);
    await expect(pill).toContainText("กำลังใช้งาน");
    await expect(pill).not.toContainText("สถานะล่าสุด");
  });

  test("says once, above the grid, that the state is derived rather than live", async ({ page }) => {
    await openMachines(page);

    // The API states this per machine as `coverage.liveState` and the page read
    // none of it, so the page whose whole subject is machine state never said it
    // had none. One notice above the grid, not 19 identical sentences on cards.
    const notice = page.locator(".machine-source-notice");
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText("ไม่มีข้อมูลสดจากเครื่อง");
    await expect(notice).toContainText("คำนวณจากแถวการใช้งาน");
  });

  test("claims no source at all when the payload carries no coverage", async ({ page }) => {
    // An older API build. Absent coverage is not an unavailable source, and the
    // two must never render the same.
    await openMachines(page, [machine({ code: "W1", coverage: undefined })]);

    await expect(page.locator(".machine-source-notice")).toHaveCount(0);
    // Freshness still governs the claim, so the card is not asserting a state
    // from an absent-coverage build either.
    await expect(statusPill(cardFor(page, "W1"))).not.toHaveClass(/status-pill--success/);
  });
});