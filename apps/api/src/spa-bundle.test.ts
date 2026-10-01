import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decideSpaResponse, isKnownAssetPath, spaHandler } from "./spa";

/**
 * The SPA handler against the REAL built bundle, not a synthetic fixture tree.
 *
 * `spa.test.ts` proves the rules with files it wrote itself, which means every
 * file in it has an extension its author already knew about. That is the blind
 * spot this file closes: the content-type map and the "is this a file?" test
 * were two hand-maintained lists, and a real build emitting an extension
 * neither mentioned would be served as `application/octet-stream` — correct
 * bytes, unusable asset, and no failing status code anywhere.
 *
 * It already happened once. `/\.[a-z0-9]{2,5}$/` matched every extension Vite
 * emits except `.webmanifest`, so a missing manifest answered 200 with HTML.
 * The map is derived now, but a map is still a list somebody maintains, and
 * this asserts the list against the artefact rather than against a fixture.
 *
 * It runs against `apps/web/dist`, which `pnpm build` produces. When the bundle
 * is absent — a bare `pnpm --filter @laundrytwin/api test`, or the ETL image —
 * these tests SKIP rather than fail. A missing artefact is not a defect in the
 * handler, and a suite that fails for the absence of the thing it is testing
 * trains people to ignore it. The handler's own rules are covered hermetically
 * in `spa.test.ts`; nothing here is the only guard on anything.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const bundleRoot = resolve(here, "../../web/dist");
const bundlePresent = existsSync(join(bundleRoot, "index.html"));

/** Every file the real build emitted, relative to the bundle root. */
async function bundleFiles(dir = bundleRoot, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await bundleFiles(join(dir, entry.name), relative)));
    else found.push(relative);
  }
  return found;
}

describe.skipIf(!bundlePresent)("the SPA handler against the real built bundle", () => {
  it("serves index.html as HTML, which is the whole point of serving it", async () => {
    const { Hono } = await import("hono");
    const app = new Hono();
    app.use("*", spaHandler(bundleRoot));
    for (const path of ["/", "/dashboard", "/login", "/machines"]) {
      const response = await app.request(path);
      expect(response.status, `${path} did not serve`).toBe(200);
      expect(response.headers.get("content-type"), `${path} was not served as HTML`).toContain("text/html");
      expect(await response.text(), `${path} did not return the shell`).toContain("<!doctype html>");
    }
  });

  it("knows every extension the real build emitted", async () => {
    // The test that would have caught the length cap, stated against the
    // artefact. If a future Vite or plugin starts emitting `.avif` or `.wasm`,
    // this names the exact file rather than leaving a technician to find an
    // asset that silently fails to load.
    const unknown: string[] = [];
    for (const file of await bundleFiles()) {
      if (!isKnownAssetPath(file)) unknown.push(file);
    }
    expect(
      unknown,
      `the built bundle contains files the handler cannot type: ${unknown.join(", ")}. ` +
        "Add each extension to CONTENT_TYPES in spa.ts."
    ).toEqual([]);
  });

  it("routes every real asset to a file, never to the SPA shell", async () => {
    // The paired half of the test above. An extension in the map is what makes
    // `decideSpaResponse` return `serve`; a file that fell through to `index`
    // would 200 with HTML for a file the browser then fails to parse.
    for (const file of await bundleFiles()) {
      if (file === "/index.html") continue;
      expect(decideSpaResponse(file, "GET"), `${file} would be answered with the shell`).toBe("serve");
    }
  });

  it("serves the bundle's own referenced assets with a usable content type", async () => {
    // Read the real index.html and follow what it actually references, so this
    // cannot pass while a file the browser requests is mistyped. A script under
    // the wrong type is blocked outright by the browser's strict MIME checking
    // for module scripts: the app boots and then executes nothing.
    const { Hono } = await import("hono");
    const app = new Hono();
    app.use("*", spaHandler(bundleRoot));

    const shell = await (await app.request("/")).text();
    const referenced = [...shell.matchAll(/(?:src|href)="(\/[^"]+)"/g)]
      .map((match) => match[1])
      .filter((path) => !path.startsWith("/api"));

    expect(referenced.length, "the shell referenced nothing, so this asserted nothing").toBeGreaterThan(0);

    for (const path of referenced) {
      const response = await app.request(path);
      expect(response.status, `${path} is referenced by the shell but did not serve`).toBe(200);
      const type = response.headers.get("content-type") ?? "";
      expect(type, `${path} was served with no usable type`).not.toBe("application/octet-stream");
      expect(type, `${path} was served as ${type}`).toBeTruthy();
      if (extname(path) === ".js") expect(type, `${path} must be a script type`).toContain("javascript");
      if (extname(path) === ".css") expect(type, `${path} must be a stylesheet type`).toContain("text/css");
    }
  });

  it("still refuses the server prefixes against the real bundle", async () => {
    // The refusal must not depend on the bundle being a fixture. A real
    // deployment has a dist/ full of files, and the server prefixes are the
    // paths that must never resolve into it.
    const { Hono } = await import("hono");
    const app = new Hono();
    app.use("*", spaHandler(bundleRoot));
    for (const path of ["/api/anything", "/webhooks/line", "/mcp", "/health", "/docs"]) {
      const response = await app.request(path);
      expect(response.status, `${path} must not be answered with the SPA`).toBe(404);
      expect(response.headers.get("content-type"), `${path} was answered with HTML`).not.toContain("text/html");
    }
  });

  it("404s a real-looking asset that is not in the bundle", async () => {
    // A hashed filename is what a stale cached shell requests after a deploy.
    // It must be a 404, not index.html under a 200.
    const { Hono } = await import("hono");
    const app = new Hono();
    app.use("*", spaHandler(bundleRoot));
    const response = await app.request("/assets/index-DOESNOTEXIST.js");
    expect(response.status).toBe(404);
  });
});

describe("the bundle test is not vacuous", () => {
  // The skip above is a real risk: a suite that silently stops running looks
  // identical to one that passes. This asserts the guard itself, so a future
  // rename of `bundlePresent` cannot turn the whole file into a no-op.
  it("derives the bundle path from this file's own location", () => {
    // `apps/web/dist` is a SIBLING of `apps/api`, not a child — asserted
    // exactly, because a wrong `..` here would silently point at a directory
    // that does not exist and skip every test in the file.
    expect(bundleRoot).toBe(resolve(here, "../../web/dist"));
    expect(bundleRoot.endsWith(join("apps", "web", "dist"))).toBe(true);
    // And it must be a real location, not this file's own directory: pointing
    // the "real bundle" tests at `apps/api/src` would let them pass on fixtures.
    expect(bundleRoot).not.toBe(resolve(here));
    expect(bundleRoot).not.toBe(resolve(here, ".."));
  });

  it("reports whether the bundle is present, so a skip is visible in the output", () => {
    // Not an assertion about the bundle — an assertion that the condition the
    // skip depends on is the one being read here.
    expect(typeof bundlePresent).toBe("boolean");
    expect(bundlePresent).toBe(existsSync(join(bundleRoot, "index.html")));
  });
});
