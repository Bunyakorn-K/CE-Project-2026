import { expect, test, type Page } from "@playwright/test";
import { installStubbedSession } from "./support/session";

/**
 * A shut branch must not present as a room full of broken machines.
 *
 * Measured on production on 2026-10-01: at roughly 22:15 local the newest
 * usage row at the real branch was 52 minutes old, so all 19 machines read
 * freshness `unavailable` and rendered a red `ไม่พร้อมใช้งาน`. Nothing was
 * broken — no usage rows arrive while a laundromat is closed. One data fact
 * (no recent usage) was asserting three things it cannot support: no evidence,
 * machine unusable, and something is wrong.
 *
 * The unit tests on `machineAvailability` cover the decision. This renders the
 * built bundle and reads the classes the browser actually paints, because the
 * symptom was a red pill on a card and only the painted class reproduces it.
 */

const LIVE_REASON = "Digital Twin state is derived from usage data; live telemetry is unavailable";

function machine(overrides: Record<string, unknown>) {
  return {
    id: `machine-${Math.random().toString(36).slice(2)}`,
    code: "W1",
    kind: "washer",
    configuredStatus: "active",
    state: "finished",
    remainingSeconds: null,
    lastSeen: "2026-10-01 14:05:00.000",
    freshness: "unavailable",
    reason: "No recent usage evidence is available for this machine",
    coverage: { liveState: { available: false, reason: LIVE_REASON } },
    ...overrides
  };
}

/**
 * The production shape: 19 machines, no recent usage, branch shut. Plus an
 * open-branch control carrying the identical freshness, which is the case a
 * naive fix would break.
 */
const CLOSED_MACHINES = [
  ...Array.from({ length: 3 }, (_unused, i) => machine({ code: `W${i + 1}` })),
  machine({ code: "D1", kind: "dryer", branchOpenState: "closed" }),
  // Same payload, branch trading: no evidence is a real fault and must stay one.
  machine({ code: "D9", kind: "dryer", branchOpenState: "open" }),
  // And the pre-feature server, which sends no branch state at all.
  machine({ code: "W7" })
];

async function openMachines(page: Page, machines = CLOSED_MACHINES): Promise<void> {
  await installStubbedSession(page, {
    responses: {
      "/api/report/branches": { branches: [{ id: "branch-fixture", name: "Fixture Branch", status: "active" }] },
      "/api/report/live": {
        live: {
          contractVersion: "clickhouse-usage-derived",
          source: "clickhouse",
          fetchedAt: "2026-10-01T15:30:00.000Z",
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

function freshnessPill(card: ReturnType<typeof cardFor>) {
  return card.locator(".machine-card-status-row .status-pill");
}

test.describe("a shut branch is not a room full of broken machines", () => {
  test("paints no machine red while the branch is closed", async ({ page }) => {
    await openMachines(page);

    // The regression itself: `closed` used to render the red
    // `ไม่พร้อมใช้งาน` pill on every card.
    await expect(freshnessPill(cardFor(page, "D1"))).not.toHaveClass(/status-pill--danger/);
    await expect(freshnessPill(cardFor(page, "D1"))).toHaveText("ปิดตามเวลาทำการ");
    // Not merely recoloured: a different sentence, because the cause is the
    // branch, not the machine.
    await expect(cardFor(page, "D1")).not.toContainText("ไม่พร้อมใช้งาน");
  });

  test("still withholds the machine state while the branch is shut", async ({ page }) => {
    await openMachines(page);

    // `closed` means "not observable", never "the machines are fine". The
    // headline must not reappear just because the alarm went quiet — that
    // would be the same defect the live-machine guard fixed, wearing new
    // clothes.
    const pill = cardFor(page, "D1").locator(".machine-card-head .status-pill");
    await expect(pill).not.toHaveClass(/status-pill--success/);
    await expect(pill).toContainText("ไม่ทราบสถานะปัจจุบัน");
    // The last recorded value stays available as history.
    await expect(cardFor(page, "D1")).toContainText("บันทึกล่าสุดว่า จบรอบแล้ว");
  });

  test("keeps a real fault red while the branch is open", async ({ page }) => {
    await openMachines(page);

    // The control that a naive fix breaks. Byte-identical to D1 except for the
    // branch state: an open branch with no evidence is the case that actually
    // warrants a technician.
    await expect(freshnessPill(cardFor(page, "D9"))).toHaveClass(/status-pill--danger/);
    await expect(freshnessPill(cardFor(page, "D9"))).toHaveText("ไม่พร้อมใช้งาน");
  });

  test("renders exactly today's pills when the API predates the feature", async ({ page }) => {
    await openMachines(page);
    // W7 carries no `branchOpenState` at all. Absent is not "closed" — if it
    // were, an account talking to an older server would silently lose the
    // machine-fault warning across every branch.
    await expect(freshnessPill(cardFor(page, "W7"))).toHaveClass(/status-pill--danger/);
    await expect(freshnessPill(cardFor(page, "W7"))).toHaveText("ไม่พร้อมใช้งาน");
  });

  test("never paints any machine red when every machine is shut", async ({ page }) => {
    await openMachines(page, [
      machine({ code: "W1", branchOpenState: "closed" }),
      machine({ code: "D1", kind: "dryer", branchOpenState: "closed" })
    ]);

    // The whole-page statement of the production symptom: 19 cards, 0 red.
    await expect(page.locator(".machine-card-status-row .status-pill--danger")).toHaveCount(0);
  });
});