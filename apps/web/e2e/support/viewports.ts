import type { Page } from "@playwright/test";

/**
 * Viewport widths the layout suite asserts against.
 *
 * These are not arbitrary samples. Each entry sits on or beside a boundary that
 * a previous defect moved:
 *
 * - 639/640  the `@media (max-width: 639px)` edge, which owns the 64px topbar
 *            and the 26px page-header `h1`.
 * - 767/768  Tailwind's `md`, which owns the grants card list vs table.
 * - 1019/1020 and 1041/1042  the two superseded nav-collapse thresholds
 *            (1041 first, 1019 before it) and the exact bands where the inline
 *            nav wrapped to two and three line boxes and grew the topbar.
 * - 1199/1200  the current threshold, which owns the nav collapse. 1200 is the
 *            narrowest viewport at which the owner header's inline nav is shown,
 *            and it sits 26.7px clear of the header's measured 1173.30px
 *            intrinsic width. The margin is the point: the previous threshold
 *            cleared that measurement by 0.70px and so passed on the machine
 *            that measured it while CI failed at 1174 with an 83px topbar. See
 *            the comment above `@media (max-width: 1199px)` in styles.css.
 *
 * The intermediate widths (768-1199) are included precisely because the
 * topbar-growth defect lived there and a boundary-only check would miss it.
 */
export const VIEWPORTS = [
  320, 375, 414, 480, 540, 600, 639, 640, 700, 767, 768, 800, 900, 1000,
  1019, 1020, 1040, 1041, 1042, 1100, 1173, 1174, 1199, 1200, 1280, 1440
] as const;

/** The widths the manual QA walked when the sign-out button was off-screen. */
export const SIGNOUT_WIDTHS = [640, 768, 1020, 1100, 1199, 1200] as const;

/**
 * The narrowest viewport at which the inline nav must fit on one 72px line.
 *
 * This is the number `styles.css` derives its `@media` threshold from, kept here
 * as the single place it is asserted. It is a measured constant, not a guess: the
 * header's intrinsic width is 1173.30px, and 1200 leaves room for the
 * macOS-vs-Linux Thai glyph shaping difference that made a 0.70px margin fail in
 * CI on 2026-10-01.
 */
export const INLINE_NAV_MIN_WIDTH = 1200;

/**
 * The headroom the inline nav must keep, in px.
 *
 * `intrinsicTopbarWidth` is measured in the browser on every layout run, and the
 * suite fails if the header comes within this of `INLINE_NAV_MIN_WIDTH`. Without
 * it, a longer account name or a new nav link widens the header until the bar
 * wraps, and the only symptom is a 72px-to-83px height change that CI reports
 * as a mystery rather than as the cause.
 */
export const INLINE_NAV_HEADROOM_PX = 20;

/**
 * Measures the owner header's real intrinsic width: the sum of its content-sized
 * parts, which is what the flex row must fit on one line.
 *
 * The header's own box cannot be used for this. `.app-topbar-inner` is capped at
 * 1280px and its children are flex-stretched, so `getBoundingClientRect()` on the
 * nav returns 736.67px on a 1280px bar -- the width it was given, not the width
 * it needs. Summing the nav's own items is what yields the real 629.97px.
 */
export async function intrinsicTopbarWidth(page: Page): Promise<{
  total: number;
  brand: number;
  navItems: number;
  navGaps: number;
  account: number;
}> {
  return page.evaluate(() => {
    const topbar = document.querySelector<HTMLElement>(".app-topbar-inner");
    const nav = document.querySelector<HTMLElement>(".primary-nav");
    if (!topbar || !nav) throw new Error("app shell did not render");
    const cs = getComputedStyle(topbar);
    const width = (sel: string): number => {
      const el = topbar.querySelector<HTMLElement>(sel);
      return el ? el.getBoundingClientRect().width : 0;
    };
    const items = Array.from(nav.querySelectorAll<HTMLElement>("a, button"));
    const navItems = items.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
    // The gaps BETWEEN the nav's own items are part of what the header needs,
    // and omitting them is how the recorded figure came to disagree with the
    // sum: five 4px gaps are exactly the 20px that separates navItems 609.97
    // from the nav's 629.97.
    const navGap = parseFloat(getComputedStyle(nav).gap) || 0;
    const navGaps = navGap * Math.max(0, items.length - 1);
    const brand = width(".brand-lockup");
    const account = width(".account-actions");
    const total =
      brand +
      navItems +
      navGaps +
      account +
      (parseFloat(cs.gap) || 0) * 2 + // brand|nav and nav|account
      parseFloat(cs.paddingLeft) +
      parseFloat(cs.paddingRight);
    return { total, brand, navItems, navGaps, account };
  });
}

export type ShellMeasurement = {
  scrollWidth: number;
  clientWidth: number;
  topbarHeight: number;
  primaryNavDisplay: string;
  mobileNavDisplay: string;
  pageHeaderFontSize: string;
};

export async function setViewport(page: Page, width: number, height = 800): Promise<void> {
  await page.setViewportSize({ width, height });
}

/** Reads the shell's layout in one round trip, from the page's own computed styles. */
export async function measureShell(page: Page): Promise<ShellMeasurement> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const topbar = document.querySelector<HTMLElement>(".app-topbar-inner");
    const primaryNav = document.querySelector<HTMLElement>(".primary-nav");
    const mobileNav = document.querySelector<HTMLElement>(".mobile-nav");
    const heading = document.querySelector<HTMLElement>(".page-header h1");
    if (!topbar || !primaryNav || !mobileNav) throw new Error("app shell did not render");
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      topbarHeight: topbar.getBoundingClientRect().height,
      primaryNavDisplay: getComputedStyle(primaryNav).display,
      mobileNavDisplay: getComputedStyle(mobileNav).display,
      pageHeaderFontSize: heading ? getComputedStyle(heading).fontSize : ""
    };
  });
}
