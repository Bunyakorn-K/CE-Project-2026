import { defineConfig, devices } from "@playwright/test";

// The layout regression suite runs the real production bundle, not the dev
// server. Two reasons:
//
//  1. `vite.config.ts` hardcodes the dev API proxy to `http://localhost:8787`,
//     so a dev-server run would silently depend on whatever happens to be
//     listening on 8787 and would break (or, worse, pass against a stranger's
//     API) when that port is busy.
//  2. The defects this protects are CSS layout defects, so what matters is the
//     shipped stylesheet. Testing `dist/` tests the artefact users load.
//
// The API is replaced by Playwright request interception in
// `e2e/support/session.ts`, which answers `/api/*` from fixtures. No API
// process, no ClickHouse, no SQLite, no `BETTER_AUTH_SECRET`.
//
// The preview port is external so a busy default does not require editing this
// file: `LAYOUT_TEST_PORT=4400 pnpm --filter @laundrytwin/web test:layout`.
const port = Number(process.env.LAYOUT_TEST_PORT ?? 4319);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  // Playwright specs are named `*.pw.ts` so vitest's default
  // `**/*.{test,spec}.?(c|m)[jt]s?(x)` glob cannot collect them. `pnpm test` is
  // the fast hermetic unit suite and must not try to run a Playwright file.
  testMatch: "**/*.pw.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Rebuild before serving so the suite always measures the stylesheet in the
  // working tree. `pnpm build` here is the web build only (tsc -b && vite build).
  //
  // `reuseExistingServer` is deliberately always false. Reusing a preview server
  // left over from an earlier run would serve whatever `dist/` that run produced,
  // so editing styles.css and re-running could pass against stale CSS. Rebuilding
  // costs ~5s; silently testing the wrong artefact would cost a missed regression.
  // `--strictPort` then fails loudly if the port is occupied rather than quietly
  // testing someone else's server; use LAYOUT_TEST_PORT to move.
  webServer: {
    command: `pnpm build && pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe"
  }
});
