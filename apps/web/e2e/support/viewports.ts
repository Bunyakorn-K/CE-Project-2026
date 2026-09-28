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
 * - 1171/1172  the current threshold. 1172 is the width at which the owner
 *            header's 1159.03px intrinsic content plus 2x24px padding fits one
 *            72px line, so 1171 must collapse and 1172 must not.
 *
 * The intermediate widths (768-1171) are included precisely because the
 * topbar-growth defect lived there and a boundary-only check would miss it.
 */
export const VIEWPORTS = [
  320, 375, 414, 480, 540, 600, 639, 640, 700, 767, 768, 800, 900, 1000,
  1019, 1020, 1040, 1041, 1042, 1100, 1171, 1172, 1280, 1440
] as const;

/** The widths the manual QA walked when the sign-out button was off-screen. */
export const SIGNOUT_WIDTHS = [640, 768, 1020, 1100, 1171, 1172] as const;

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
