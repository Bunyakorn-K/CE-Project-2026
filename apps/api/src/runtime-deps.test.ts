import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The runtime image does NOT install from the lockfile.
//
// `apps/api/Dockerfile`'s runtime stage has no package manager and no lockfile:
// it runs `npm install --no-save` on a hand-written list of the API's external
// runtime dependencies. That is deliberate — the stage is alpine, and the
// externals are the ones esbuild must not inline — but it means the versions
// shipped are the ones typed here, not the ones pnpm resolved.
//
// Which makes them invisible to Dependabot, which reads pnpm-lock.yaml. That is
// not hypothetical: zod@4.4.3 sat in this list while the lockfile had moved on,
// so every alert for zod was closed by a lockfile bump that did not reach the
// image. These guards read the two files and compare them.
//
// The Dockerfile also asserts the patched floors at build time; this test is the
// one that runs before the build, so a bad pin fails in CI in 200ms instead of
// after a five-minute image build.

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const lockfile = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");

/** The packages the runtime stage installs, per the comment above. */
const RUNTIME_PACKAGES = [
  "better-sqlite3",
  "dotenv",
  "ai",
  "@ai-sdk/openai-compatible",
  "@vercel/oidc",
  "zod"
];

/** Patched floors from Dependabot advisories; anything below ships a known bug. */
const PATCHED_FLOORS: Record<string, string> = {
  zod: "4.6.6"
};

function pinnedSpec(pkg: string): string | null {
  const at = dockerfile.indexOf("npm install --no-save --omit=dev");
  expect(at).toBeGreaterThan(-1);
  const block = dockerfile.slice(at, dockerfile.indexOf("npm cache clean", at));
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`^\\s*${escaped}@([0-9][^\\s\\\\]*)`, "m"));
  return match ? match[1] : null;
}

function parse(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

function isBelow(actual: string, minimum: string): boolean {
  const a = parse(actual);
  const b = parse(minimum);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function resolvedInLock(pkg: string): string[] {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new Set<string>();
  const pattern = new RegExp(`^\\s{2,6}'?${escaped}@([0-9][^:'(]*)`, "gm");
  for (const match of lockfile.matchAll(pattern)) found.add(match[1].trim());
  return [...found];
}

describe("runtime image dependencies", () => {
  it("installs exactly the external runtime set", () => {
    for (const pkg of RUNTIME_PACKAGES) {
      expect(pinnedSpec(pkg), `${pkg} missing from the runtime install`).not.toBeNull();
    }
  });

  it("never pins a version below a patched floor", () => {
    for (const [pkg, floor] of Object.entries(PATCHED_FLOORS)) {
      const pinned = pinnedSpec(pkg);
      expect(pinned, `${pkg} is not pinned`).not.toBeNull();
      expect(isBelow(pinned as string, floor), `${pkg}@${pinned} is below the patched ${floor}`).toBe(false);
    }
  });

  it("keeps each pin equal to the version the lockfile resolved", () => {
    // A pin above the lockfile is not automatically wrong, but it means the image
    // and the tests are running different code — say so rather than let it drift.
    for (const pkg of RUNTIME_PACKAGES) {
      const resolved = resolvedInLock(pkg);
      if (resolved.length === 0) continue; // not in the pruned lock for this app
      const pinned = pinnedSpec(pkg);
      expect(resolved, `${pkg}: image pins ${pinned}, lockfile has ${resolved.join(", ")}`).toContain(pinned);
    }
  });

  it("also fails the image build when a pin is below a floor", () => {
    // The test above runs in CI; this one runs inside the build, where the shipped
    // tree is the only thing that can be inspected.
    expect(dockerfile).toContain("is below the patched");
    expect(dockerfile).toContain("process.exit(1)");
  });
});
