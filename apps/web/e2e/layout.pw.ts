import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gotoAuthenticated, installStubbedSession } from "./support/session";
import {
  INLINE_NAV_HEADROOM_PX,
  INLINE_NAV_MIN_WIDTH,
  intrinsicTopbarWidth,
  measureShell,
  setViewport,
  SIGNOUT_WIDTHS,
  VIEWPORTS
} from "./support/viewports";

/**
 * Layout regression suite for the three defects fixed in 0a58da1, bed5f3f and
 * 70f5e5d, none of which had committed test coverage.
 *
 * 1. Page-level horizontal overflow between 640px and ~1017px: the header nav
 *    could not fit, so `documentElement.scrollWidth` exceeded `clientWidth` and
 *    the sign-out button and "ตั้งค่า AI" were pushed off-screen.
 * 2. The topbar growing past 72px when the inline nav wrapped to two or three
 *    line boxes (the 1020-1040 and 1042-1173 bands), before the collapse
 *    threshold moved to 1173px.
 * 3. The grants table-to-card breakpoint at 768px, and the page-header
 *    typography (26px at <=639, 32px at >=640).
 *
 * These are behavioural assertions against the real production bundle. Reading
 * `styles.css` for a literal would not catch a regression caused by any other
 * rule; measuring the rendered page catches the symptom instead.
 */

test.describe("LaundryTwin operations shell", () => {
  test.beforeEach(async ({ page }) => {
    await installStubbedSession(page);
  });

  test("never overflows horizontally at any supported width", async ({ page }) => {
    // The first defect: the whole page scrolled sideways, taking the sign-out
    // button and the "ตั้งค่า AI" link with it. scrollWidth must equal
    // clientWidth everywhere, which is the invariant that keeps every element
    // inside the viewport.
    await setViewport(page, 320);
    await gotoAuthenticated(page, "/dashboard");

    const overflowing: string[] = [];
    for (const width of VIEWPORTS) {
      await setViewport(page, width);
      const { scrollWidth, clientWidth } = await measureShell(page);
      if (scrollWidth !== clientWidth) {
        overflowing.push(`${width}px: scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`);
      }
    }
    expect(overflowing, `horizontal overflow at: ${overflowing.join(", ")}`).toEqual([]);
  });

  test("keeps the topbar at 64px below 640px and exactly 72px above it", async ({ page }) => {
    // The second defect: the inline nav wrapped, the flex row grew to 83px or
    // 102.5px, and the header silently changed height across the middle of the
    // breakpoint range. `min-height` alone is not enough, so this asserts the
    // measured box, not the declaration.
    await setViewport(page, 320);
    await gotoAuthenticated(page, "/dashboard");

    const wrongHeight: string[] = [];
    for (const width of VIEWPORTS) {
      await setViewport(page, width);
      const { topbarHeight } = await measureShell(page);
      const expected = width <= 639 ? 64 : 72;
      if (topbarHeight !== expected) {
        wrongHeight.push(`${width}px: ${topbarHeight}px, expected ${expected}px`);
      }
    }
    expect(wrongHeight, `unexpected topbar height: ${wrongHeight.join(", ")}`).toEqual([]);
  });

  test("keeps the inline nav clear of the width the header actually needs", async ({ page }) => {
    // The guard that keeps the threshold honest. Every previous threshold was
    // derived from a measurement recorded in a comment, and the last one cleared
    // that measurement by 0.70px — so it passed on the machine that measured it
    // and failed in CI on 2026-10-01 with an 83px topbar at 1174px, on the same
    // Chromium build and the same vendored font. A longer account name or one new
    // nav link widens the header the same way, and without this the only symptom
    // is a height change nobody can explain.
    //
    // So the header's real intrinsic width is measured here, in the browser, on
    // every run, and the threshold has to keep its headroom.
    await installStubbedSession(page);
    await gotoAuthenticated(page, "/dashboard");
    await setViewport(page, 1440);

    // Fonts must be settled first: `font-display: swap` means a measurement taken
    // before the face loads is a measurement of the fallback, which is a
    // different number and would fail this for the wrong reason.
    await page.evaluate(() => document.fonts.ready);

    const { total, brand, navItems, navGaps, account } = await intrinsicTopbarWidth(page);
    const headroom = INLINE_NAV_MIN_WIDTH - total;
    expect(
      headroom,
      `the owner header now needs ${total.toFixed(2)}px ` +
        `(brand ${brand.toFixed(2)} + nav ${(navItems + navGaps).toFixed(2)} + account ${account.toFixed(2)} ` +
        `+ gaps and padding), which leaves only ${headroom.toFixed(2)}px below the ` +
        `${INLINE_NAV_MIN_WIDTH}px inline-nav threshold — less than the required ` +
        `${INLINE_NAV_HEADROOM_PX}px. At ${INLINE_NAV_MIN_WIDTH - 1}px the nav would fit by ` +
        `under a pixel and the topbar would grow to 83px. Raise INLINE_NAV_MIN_WIDTH and the ` +
        `@media (max-width: ...) threshold in styles.css together, then re-measure.`
    ).toBeGreaterThanOrEqual(INLINE_NAV_HEADROOM_PX);
  });

  test("keeps the CSS threshold and the measured width in one place", async () => {
    // The headroom test above measures the header; this one makes sure the CSS
    // actually implements the number it measures against. Without it the two can
    // drift: the earlier threshold was 1173 in the stylesheet while the constant
    // said 1200, and a green headroom test would have said nothing while the
    // stylesheet shipped the wrong band. That drift IS the original defect — a
    // threshold asserted in a comment and a stylesheet, never read from each
    // other.
    const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
    const thresholds = [...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
    // The nav-collapse block is the one immediately governing `.primary-nav`.
    const navBlock = css.match(/@media \(max-width: (\d+)px\)\s*\{\s*\.primary-nav\s*\{/);
    expect(
      navBlock,
      "no @media block setting .primary-nav display was found in styles.css"
    ).not.toBeNull();

    const cssThreshold = Number(navBlock![1]);
    expect(
      cssThreshold,
      `styles.css collapses the inline nav at max-width ${cssThreshold}px, but ` +
        `INLINE_NAV_MIN_WIDTH is ${INLINE_NAV_MIN_WIDTH}px. The stylesheet must collapse at ` +
        `INLINE_NAV_MIN_WIDTH - 1, or the measured headroom above is checking a threshold ` +
        `that is not the one shipping.`
    ).toBe(INLINE_NAV_MIN_WIDTH - 1);

    // The 639px block owns the 64px topbar and must not be confused for this one.
    expect(thresholds, "the 639px topbar block should still be present").toContain(639);
  });

  test("collapses the inline nav into the hamburger below the threshold and restores it above", async ({ page }) => {
    // The regression that produced five commits: 1019, then 1041, then 1171,
    // then 1173, then 1199. Every one of those thresholds left a band where the
    // inline nav was shown but could not fit. The boundary pair below is the
    // actual contract, and it is asserted in both directions so neither a too-low
    // nor a too-high threshold can pass.
    await setViewport(page, 320);
    await gotoAuthenticated(page, "/dashboard");

    const collapseAt = INLINE_NAV_MIN_WIDTH - 1;
    await setViewport(page, collapseAt);
    let shell = await measureShell(page);
    expect(shell.primaryNavDisplay, `inline nav must be hidden at ${collapseAt}px`).toBe("none");
    expect(shell.mobileNavDisplay, `hamburger must be shown at ${collapseAt}px`).toBe("block");

    await setViewport(page, INLINE_NAV_MIN_WIDTH);
    shell = await measureShell(page);
    expect(shell.primaryNavDisplay, `inline nav must be shown at ${INLINE_NAV_MIN_WIDTH}px`).not.toBe("none");
    expect(shell.mobileNavDisplay, `hamburger must be hidden at ${INLINE_NAV_MIN_WIDTH}px`).toBe("none");
  });

  test("shows exactly one navigation control at every width", async ({ page }) => {
    // Guards the whole range, not just the boundary: showing both or neither
    // is how the nav becomes unreachable without any single boundary changing.
    await setViewport(page, 320);
    await gotoAuthenticated(page, "/dashboard");

    const bothOrNeither: string[] = [];
    for (const width of VIEWPORTS) {
      await setViewport(page, width);
      const { primaryNavDisplay, mobileNavDisplay } = await measureShell(page);
      const inlineVisible = primaryNavDisplay !== "none";
      const hamburgerVisible = mobileNavDisplay !== "none";
      if (inlineVisible === hamburgerVisible) {
        bothOrNeither.push(`${width}px: inline=${primaryNavDisplay} hamburger=${mobileNavDisplay}`);
      }
    }
    expect(bothOrNeither, `both or neither nav shown at: ${bothOrNeither.join(", ")}`).toEqual([]);
  });

  test("sizes the page-header h1 at 26px below 640px and 32px above it", async ({ page }) => {
    // From the earlier five-defect fix, which this suite was asked to protect
    // along with the three later ones.
    await setViewport(page, 320);
    await gotoAuthenticated(page, "/dashboard");

    const wrongSize: string[] = [];
    for (const width of VIEWPORTS) {
      await setViewport(page, width);
      const { pageHeaderFontSize } = await measureShell(page);
      const expected = width <= 639 ? "26px" : "32px";
      if (pageHeaderFontSize !== expected) {
        wrongSize.push(`${width}px: ${pageHeaderFontSize}, expected ${expected}`);
      }
    }
    expect(wrongSize, `unexpected h1 size: ${wrongSize.join(", ")}`).toEqual([]);
  });

  test("keeps the sign-out button visible, in-viewport and hit-testable at every width", async ({ page }) => {
    // The user-visible consequence of defect 1. A button that has overflowed
    // off-screen is still "visible" to a naive bounding-box check, so this also
    // hit-tests the centre point with elementFromPoint: that only returns the
    // button if nothing is painted on top of it.
    for (const width of SIGNOUT_WIDTHS) {
      await setViewport(page, width);
      await gotoAuthenticated(page, "/dashboard");

      const signout = page.locator(".signout-button");
      await expect(signout, `sign-out button missing at ${width}px`).toBeVisible();

      const state = await signout.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const root = document.documentElement;
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          inViewport: rect.left >= 0 && rect.right <= root.clientWidth,
          hitTestable: hit === element || element.contains(hit),
          width: rect.width,
          height: rect.height
        };
      });

      expect(state.inViewport, `sign-out button is outside the ${width}px viewport`).toBe(true);
      expect(state.hitTestable, `sign-out button is not hit-testable at ${width}px`).toBe(true);
      // Below 640px the label collapses to a 36px icon; it must stay a real
      // touch target either way.
      expect(state.width, `sign-out button collapsed to ${state.width}px at ${width}px`).toBeGreaterThanOrEqual(36);
      expect(state.height, `sign-out button is only ${state.height}px tall at ${width}px`).toBeGreaterThanOrEqual(36);
    }
  });

  test("signs out when the sign-out button is clicked", async ({ page }) => {
    // "Clickable" has to mean the click reaches the handler. The stubbed API
    // answers the sign-out calls, then the app routes to /login.
    await setViewport(page, 640);
    await gotoAuthenticated(page, "/dashboard");
    await page.locator(".signout-button").click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("keeps the topbar sticky so the sign-out control stays reachable while scrolling", async ({ page }) => {
    // Cheap, and it protects the property that makes the control reachable at
    // all on a long page.
    await setViewport(page, 640);
    await gotoAuthenticated(page, "/dashboard");
    await page.evaluate(() => window.scrollTo(0, 2000));
    const { topbarHeight } = await measureShell(page);
    expect(topbarHeight).toBe(72);
    await expect(page.locator(".signout-button")).toBeVisible();
  });
});

test.describe("admin grants layout", () => {
  test.beforeEach(async ({ page }) => {
    await installStubbedSession(page);
  });

  test("switches the grants list from cards to a table at 768px", async ({ page }) => {
    // Tailwind's `md` (768px) drives `md:hidden` / `hidden md:block` in
    // routes/_authenticated/admin/index.tsx. Both sides of the boundary are
    // asserted, because showing both at once is a duplicate-content regression
    // and showing neither loses the access-management list entirely.
    const cardList = page.locator("ul.admin-list");
    const table = page.locator("table.admin-table");

    for (const width of [320, 540, 639, 640, 700, 767]) {
      await setViewport(page, width);
      await gotoAuthenticated(page, "/admin");
      await expect(cardList.first(), `card list must be visible at ${width}px`).toBeVisible();
      await expect(table, `table must be hidden at ${width}px`).toBeHidden();
    }

    // 1280 rather than 1174: this asserts the grants table, and 1174 now sits
    // below the nav threshold, so it renders a shell state this test is not about.
    for (const width of [768, 900, 1280, 1440]) {
      await setViewport(page, width);
      await gotoAuthenticated(page, "/admin");
      await expect(cardList.first(), `card list must be hidden at ${width}px`).toBeHidden();
      await expect(table, `table must be visible at ${width}px`).toBeVisible();
    }
  });

  test("keeps human-readable card values in the body font and identifiers monospace", async ({ page }) => {
    // The card list was reusing `.request-identity`, whose rules set 10px
    // monospace labels and 11px monospace values, so a grant's user name, role
    // and branch name rendered as data. DESIGN.md's measurement rule allows
    // monospace for identifiers, timestamps and measurements only. This reads
    // the computed style rather than the stylesheet, because the defect was a
    // cascade-layer problem: Tailwind's `font-sans text-sm` inside
    // `.request-identity` is silently defeated by the unlayered rules, so a
    // source-level assertion would pass while the defect was still on screen.
    await setViewport(page, 390);
    await gotoAuthenticated(page, "/admin");

    const fields = await page.locator("[data-grant-card]").first().evaluate((card) => {
      const read = (el: Element) => {
        const style = getComputedStyle(el);
        return { text: el.textContent ?? "", family: style.fontFamily, size: parseFloat(style.fontSize) };
      };
      const groups = [...card.querySelectorAll("div > div")];
      return groups.map((group) => ({
        label: read(group.querySelector("span")!),
        values: [...group.querySelectorAll("strong, small")].map(read)
      }));
    });

    // One group per field: user (name + email), role, scope, granted-at.
    expect(fields).toHaveLength(4);
    for (const { label } of fields) {
      expect(label.size, `label "${label.text}" is below 12px`).toBeGreaterThanOrEqual(12);
    }
    // Name, role and scope are prose the owner reads, so body font at 12px or
    // more. The email, the branch UUID and the granted-at timestamp are the
    // identifier and timestamp cases the rule keeps in monospace.
    for (const value of [fields[0].values[0], fields[1].values[0], fields[2].values[0]]) {
      expect(value.family, `"${value.text}" is set in monospace`).not.toContain("monospace");
      expect(value.size, `"${value.text}" is only ${value.size}px`).toBeGreaterThanOrEqual(12);
    }
    for (const value of [fields[0].values[1], fields[3].values[0]]) {
      expect(value.family, `"${value.text}" lost its monospace data treatment`).toContain("monospace");
      expect(value.size, `"${value.text}" is only ${value.size}px`).toBeGreaterThanOrEqual(12);
    }
  });

  test("does not overflow horizontally on the admin page at any width", async ({ page }) => {
    // The table has five columns, so it is the most likely place for a new
    // overflow regression to appear. `.table-scroll` is allowed to scroll
    // itself, but the page must not.
    await setViewport(page, 320);
    await gotoAuthenticated(page, "/admin");

    const overflowing: string[] = [];
    for (const width of VIEWPORTS) {
      await setViewport(page, width);
      const { scrollWidth, clientWidth } = await measureShell(page);
      if (scrollWidth !== clientWidth) {
        overflowing.push(`${width}px: scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`);
      }
    }
    expect(overflowing, `horizontal overflow at: ${overflowing.join(", ")}`).toEqual([]);
  });
});
