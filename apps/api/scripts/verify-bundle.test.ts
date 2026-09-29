import { build } from "esbuild";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleExternals, bundleOptions } from "../esbuild.config.mjs";

const run = promisify(execFile);
const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(apiDir, "../..");

// Regression guard for the 29c45c0 production boot failure.
//
// Shipping a bundle that builds but whose module graph throws on import is a
// boot-loop: the image is fine, the process dies before it serves. That is
// invisible to the vitest suite, which runs against source, so this test
// bundles the real production entry with the real production esbuild options
// and then evaluates the artefact.
//
// It is deliberately not a source-level test: only the bundle reproduces it.
describe("production bundle", () => {
  let sandbox: string;
  let bundlePath: string;

  beforeAll(async () => {
    // Build inside a sandbox laid out like the repo (apps/api/dist + node_modules)
    // so the bundle's own externals still resolve, but three levels up there is
    // no .env. src/config.ts reads <root>/.env on import, so a plain tmpdir
    // build would either fail to resolve modules or pick up the developer's real
    // credentials and databases. The sandbox must not.
    sandbox = mkdtempSync(join(tmpdir(), "laundrytwin-bundle-guard-"));
    const sandboxApi = join(sandbox, "apps", "api");
    const sandboxDist = join(sandboxApi, "dist");
    mkdirSync(sandboxDist, { recursive: true });
    symlinkSync(join(repoRoot, "node_modules"), join(sandbox, "node_modules"), "dir");
    symlinkSync(join(apiDir, "node_modules"), join(sandboxApi, "node_modules"), "dir");

    bundlePath = join(sandboxDist, "index.mjs");
    await build({ ...bundleOptions, outfile: bundlePath });
  }, 120_000);

  afterAll(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  it("evaluates its module graph on import", async () => {
    // Import the bundle, do not run it: src/index.ts only calls serve() when it is
    // the process entrypoint, so this constructs the Hono app and the MCP server
    // without binding a port. A minimal env satisfies config validation; the
    // sandbox has no .env and no upstream credentials, so nothing real is touched.
    const script = `
      const mod = await import(${JSON.stringify(bundlePath)});
      // Importing already proved the module graph evaluated. Check the Hono app
      // was actually constructed, so a stripped or half-linked bundle fails too.
      const app = mod.app ?? mod.default;
      if (!app || typeof app.fetch !== "function") throw new Error("bundle exported no Hono app");
      console.log("BUNDLE_EVALUATED");
    `;
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
      cwd: sandbox,
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "bundle-guard-not-a-real-secret-000000000000",
        DATABASE_PATH: join(sandbox, "guard.sqlite")
      }
    });
    expect(stdout).toContain("BUNDLE_EVALUATED");
  }, 90_000);

  it("keeps zod external so the MCP SDK's eager z.custom() call is ordered", () => {
    // The precise mechanism behind the crash: when zod is inlined, esbuild wraps
    // it in lazy __esm initialisers and the SDK's top-level z.custom() call can
    // run before ZodCustom is assigned. Assert the invariant directly so the
    // reason zod is external cannot be quietly deleted.
    expect(bundleExternals).toContain("zod");
    expect(bundleExternals).toContain("zod/*");
  });

  it("installs every concrete external in the runtime image", () => {
    // The Dockerfile runtime layer is a hand-written list, independent of
    // pnpm-lock.yaml. If an external is bundled-away in esbuild but missing from
    // that list, the image boots to "Cannot find package". The two files drifted
    // once already: the Dockerfile documented zod as external while
    // esbuild.config.mjs inlined it, which is how the 29c45c0 boot loop shipped.
    const dockerfile = readFileSync(join(apiDir, "Dockerfile"), "utf8");
    const runtimeInstall = dockerfile.match(/npm install --no-save --omit=dev([\s\S]*?)&& npm cache clean/);
    expect(runtimeInstall, "Dockerfile runtime npm install block not found").toBeTruthy();

    // Wildcard entries (@ai-sdk/*) expand to the real packages in the image.
    const concrete = bundleExternals
      .filter((name) => !name.includes("*"))
      // drizzle-kit is a devDependency (db:generate/db:push only) and is never
      // imported at runtime, so the image deliberately does not install it.
      .filter((name) => name !== "drizzle-kit");

    for (const name of concrete) {
      expect(runtimeInstall?.[1], `${name} is external but not installed in the runtime image`)
        .toContain(`${name}@`);
    }
  });
});
