import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentTypeFor, decideSpaResponse, isServerPath, resolveWithinRoot, spaHandler } from "./spa";

/**
 * The SPA fallback is the one place where a routing convenience can destroy an
 * API contract, so the assertions below are about what it REFUSES to answer.
 *
 * The failure this guards is concrete: `try_files $uri /index.html` applied to
 * `/api/*` turns a caller's typo into 200-with-HTML. The web maps error codes
 * through `api-errors.ts`, so the HTML body does not render as an error at all
 * — it surfaces as a parse failure with no code to map, which is the same
 * "caller error reported as something else" class as the 502-for-a-bad-cursor
 * defect. The `reject` assertions are therefore the load-bearing ones.
 */

describe("isServerPath", () => {
  it("claims the server's own prefixes", () => {
    for (const path of ["/api", "/api/report/dashboard", "/mcp", "/webhooks/line", "/health", "/docs"]) {
      expect(isServerPath(path), `${path} must be the server's`).toBe(true);
    }
  });

  it("does not claim a client-side route that merely starts with the same letters", () => {
    // `/apidocs` and `/mcp-ish` are routes a SPA could legitimately own. A
    // prefix test without the `/` boundary would swallow both and return HTML
    // where a page or a JSON 404 belongs.
    for (const path of ["/apidocs", "/mcpish", "/healthy-tips", "/api-docs"]) {
      expect(isServerPath(path), `${path} must NOT be the server's`).toBe(false);
    }
  });
});

describe("decideSpaResponse", () => {
  it("boots the app for a client-side route so a deep link survives a reload", () => {
    // This is the job nginx's `try_files $uri $uri/ /index.html` did. Without
    // it, reloading /dashboard 404s and the product looks broken on refresh
    // while working fine in-app.
    for (const path of ["/", "/login", "/dashboard", "/machines", "/admin"]) {
      expect(decideSpaResponse(path, "GET"), `${path} must serve index.html`).toBe("index");
    }
  });

  it("refuses every server path, so a missing API route stays a 404", () => {
    for (const path of ["/api/nope", "/api/report/typo", "/mcp", "/webhooks/line", "/health", "/docs"]) {
      expect(decideSpaResponse(path, "GET"), `${path} must not be answered with the SPA`).toBe("reject");
    }
  });

  it("treats an extension-bearing path as a file, never as a route", () => {
    // `serve` means "try the file, 404 if absent" — the handler test below
    // proves the 404. The point of the split is that a missing bundle file can
    // never resolve to index.html, which renders a blank page whose only
    // symptom is a console error.
    expect(decideSpaResponse("/assets/index-abc123.js", "GET")).toBe("serve");
    expect(decideSpaResponse("/fonts/nope.woff2", "GET")).toBe("serve");
  });

  it("treats a long KNOWN extension as a file, which a length cap got wrong", () => {
    // The measured failure: `/\.[a-z0-9]{2,5}$/` matched every extension a Vite
    // build actually emits — and silently missed `.webmanifest` at 11 chars. A
    // request for a missing manifest was therefore routed to `index` and
    // answered 200 with HTML, the one outcome a caller cannot tell from a real
    // file. The rule is membership of the content-type map, not length, so
    // adding a long extension to that map is enough to make it a file.
    expect(decideSpaResponse("/manifest.webmanifest", "GET")).toBe("serve");
    // And the boundary that keeps it from being "long = file": an extension
    // nobody has a type for is a route, not a file. Serving it would mean
    // serving bytes under a guessed type.
    expect(decideSpaResponse("/site.javascript", "GET")).toBe("index");
    expect(decideSpaResponse("/site.somethinglong", "GET")).toBe("index");
  });

  it("matches the extension case-insensitively, in both the file test and the type", () => {
    // Both halves, because they are two lookups and the second one was
    // originally the only one covered. A `.CSS` that resolves to a file but is
    // then labelled `application/octet-stream` is broken in a way no status code
    // reveals, and a `.CSS` that fails the file test is the shell instead —
    // which is how the case bug was able to hide here.
    expect(decideSpaResponse("/assets/INDEX-ABC.CSS", "GET")).toBe("serve");
    expect(contentTypeFor("/assets/INDEX-ABC.CSS")).toBe("text/css; charset=utf-8");
    expect(decideSpaResponse("/MANIFEST.WEBMANIFEST", "GET")).toBe("serve");
  });

  it("still boots the app for a route that merely contains a dot", () => {
    // The other direction, and the reason the test is not just "dotted = file".
    // No client route in the web app contains a dot, so a dotted path with no
    // known extension is a route, and answering it with the shell is correct.
    for (const path of ["/v1.2/notes", "/user.name", "/a.b.c"]) {
      expect(decideSpaResponse(path, "GET"), `${path} must boot the app`).toBe("index");
    }
  });

  it("refuses a traversal-shaped path even when it carries no extension", () => {
    // Without the `..` test this reached `index` and booted the app, so the
    // traversal was answered 200 with HTML rather than 404.
    expect(decideSpaResponse("/../../../../etc/passwd", "GET")).toBe("reject");
    expect(decideSpaResponse("/a/../b", "GET")).toBe("reject");
    expect(decideSpaResponse("/%2e%2e/secret", "GET")).toBe("reject");
  });

  it("refuses a non-GET so a webhook retry loop cannot read as success", () => {
    // A POST to an unknown path is a wrong URL. 200-with-HTML would let LINE
    // mark a delivery as delivered against a route that does not exist.
    expect(decideSpaResponse("/webhooks/line-wrong", "POST")).toBe("reject");
    expect(decideSpaResponse("/anything", "POST")).toBe("reject");
    expect(decideSpaResponse("/anything", "DELETE")).toBe("reject");
  });

  it("allows HEAD, because a router may probe a deep link with it", () => {
    expect(decideSpaResponse("/dashboard", "HEAD")).toBe("index");
  });
});

describe("resolveWithinRoot", () => {
  const root = "/srv/app/public";

  it("resolves a normal asset path inside the root", () => {
    expect(resolveWithinRoot(root, "/assets/index-abc.js")).toBe("/srv/app/public/assets/index-abc.js");
  });

  it("refuses a relative path that walks out of the web root", () => {
    // The handler reads from the filesystem, so this is a file-disclosure guard
    // and not a theoretical one. A path with NO leading slash is the form that
    // actually escapes: `join` treats a leading-slash path as root-relative and
    // collapses `/../../etc/passwd` to `root/etc/passwd`, which is inside the
    // root and harmless. A relative one walks out for real.
    expect(resolveWithinRoot(root, "../../etc/passwd")).toBeNull();
    expect(resolveWithinRoot(root, "assets/../../../etc/passwd")).toBeNull();
  });

  it("refuses a traversal that only escapes after decoding", () => {
    // The encoded form is what a request actually carries, so resolving the
    // literal string would check the wrong path entirely.
    expect(resolveWithinRoot(root, "%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  });

  it("refuses a sibling directory that shares the root's name prefix", () => {
    // `/srv/app/public-backup` starts with `/srv/app/public` as a STRING. Only
    // the separator in the prefix test makes it a non-child.
    expect(resolveWithinRoot(root, "../public-backup/secret.env")).toBeNull();
  });

  it("confines a leading-slash traversal to the root rather than escaping it", () => {
    // Documents the mechanism honestly: `join` drops the `..` because the second
    // argument is absolute, so the result stays under the root and 404s on the
    // missing file. Safe, but by normalization rather than by the prefix test.
    expect(resolveWithinRoot(root, "/../../etc/passwd")).toBe("/srv/app/public/etc/passwd");
  });

  it("refuses a malformed percent-encoding rather than throwing", () => {
    // A URIError escaping the handler would answer a bad request with a 500.
    expect(resolveWithinRoot(root, "/%E0%A4%A")).toBeNull();
  });
});

describe("contentTypeFor", () => {
  it("labels the shell as HTML, which is the whole point of serving it", () => {
    // The defect this exists for: `c.body()` does not infer a MIME type. Without
    // this the shell was returned as `text/plain`, so a browser displayed the
    // source of the page instead of rendering it — a 200, correct bytes, and a
    // product that looked like a raw text file.
    expect(contentTypeFor("/app/public/index.html")).toBe("text/html; charset=utf-8");
  });

  it("labels each asset kind a Vite emits, not just the shell", () => {
    // The shell alone is not enough. A stylesheet served as text/plain is
    // ignored, a font served as octet-stream still loads, but a script served
    // under the wrong type is blocked by the browser's strict MIME checking for
    // module scripts — the app boots and then executes nothing.
    expect(contentTypeFor("/assets/index-abc123.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("/assets/index-abc123.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("/assets/icon-abc123.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("/assets/noto-abc123.woff2")).toBe("font/woff2");
  });

  it("falls back to octet-stream, which downloads rather than executes", () => {
    // The safe direction for an unknown type. `text/plain` would also be inert
    // today, but the reason to name octet-stream is that it is the honest
    // answer: we do not know what this file is, so we decline to guess a type
    // a browser might act on.
    expect(contentTypeFor("/assets/blob-abc123.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("/assets/noextension")).toBe("application/octet-stream");
  });

  it("is case-insensitive, because an asset may arrive uppercased", () => {
    expect(contentTypeFor("/assets/INDEX-ABC123.CSS")).toBe("text/css; charset=utf-8");
  });
});

describe("spaHandler", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "laundrytwin-spa-"));
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "index.html"), "<!doctype html><div id=root></div>");
    await writeFile(join(root, "assets", "index-abc123.js"), "export const x=1");
    await writeFile(join(root, "assets", "index-abc123.css"), "body{margin:0}");
    await writeFile(join(root, "assets", "icon-abc123.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await writeFile(join(root, "assets", "noto-abc123.woff2"), "wOF2");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function run(path: string, init?: RequestInit) {
    const { Hono } = await import("hono");
    const app = new Hono();
    app.get("/api/real", (c) => c.json({ ok: true }));
    app.use("*", spaHandler(root));
    return app.request(path, init);
  }

  it("serves index.html for a client-side route", async () => {
    const response = await run("/dashboard");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("id=root");
  });

  it("serves a real asset with an immutable cache header", async () => {
    const response = await run("/assets/index-abc123.js");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("export const x=1");
    expect(response.headers.get("Cache-Control")).toContain("immutable");
  });

  it("labels the shell text/html, so a browser renders it instead of printing it", async () => {
    // End-to-end, not via the pure function: the header is set on the response
    // and `c.body()` would otherwise default it to text/plain. A 200 with
    // correct bytes and the wrong type is exactly the failure that reached the
    // live smoke and would have shipped a product that displayed as source.
    for (const path of ["/", "/dashboard"]) {
      const response = await run(path);
      expect(response.headers.get("content-type"), `${path} was not served as HTML`).toContain("text/html");
    }
  });

  it("labels each asset kind on the wire, not just in the map", async () => {
    // The pure-function tests cannot catch a header that is computed and then
    // never applied, so the wiring is asserted too.
    const cases = [
      ["/assets/index-abc123.js", "text/javascript"],
      ["/assets/index-abc123.css", "text/css"],
      ["/assets/icon-abc123.svg", "image/svg+xml"],
      ["/assets/noto-abc123.woff2", "font/woff2"]
    ] as const;
    for (const [path, expected] of cases) {
      const response = await run(path);
      expect(response.status, `${path} did not serve`).toBe(200);
      expect(response.headers.get("content-type"), `${path} had the wrong type`).toContain(expected);
    }
  });

  it("keeps a JSON API response as JSON rather than retyping it", async () => {
    // The SPA handler runs last, so this is about not making it worse: if the
    // fallback were ever hoisted above the API routes, an `application/json`
    // response would still be correct only because the API sets its own header.
    const response = await run("/api/real");
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("never caches index.html, or a deploy strands browsers on a dead shell", async () => {
    // The shell names hashed assets. Cached, it survives a deploy and
    // references files that no longer exist — a blank page, no error.
    const response = await run("/dashboard");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("404s a missing asset instead of returning the shell", async () => {
    const response = await run("/assets/gone.js");
    expect(response.status).toBe(404);
  });

  it("404s a missing long-extension asset rather than answering 200 with the shell", async () => {
    // The end-to-end form of the length-cap defect. This is what a browser saw:
    // 200 OK, HTML, for a file that does not exist.
    const response = await run("/manifest.webmanifest");
    expect(response.status, "a missing manifest must be a 404, not the SPA shell").toBe(404);
  });

  it("404s an unknown API route rather than answering with HTML", async () => {
    const response = await run("/api/typo");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toContain("text/html");
  });

  it("leaves a real API route to the API", async () => {
    const response = await run("/api/real");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("never discloses a file from outside the web root", async () => {
    // The property that matters, stated as content rather than status. The URL
    // parser collapses `..` before routing, so `/../../etc/passwd` reaches the
    // handler as `/etc/passwd` — an extensionless path, which the SPA answers
    // with index.html exactly as nginx's `try_files $uri /index.html` did. That
    // is the pre-existing behaviour and is not the security boundary; the
    // boundary is that no byte of a file outside the root is ever returned.
    for (const path of ["/%2e%2e/%2e%2e/%2e%2e/etc/passwd", "/../../../../etc/passwd", "/etc/passwd"]) {
      const response = await run(path);
      const body = await response.text();
      expect(body, `${path} returned a file from outside the web root`).not.toContain("root:");
      expect(body, `${path} returned a file from outside the web root`).not.toMatch(/bin\/bash|daemon/);
    }
  });

  it("refuses to read a traversal that survives URL parsing", async () => {
    // `%2e%2e%2f` is NOT collapsed by the URL parser — it stays encoded in the
    // pathname — so this is the one traversal form that reaches the handler
    // intact, and the one the `..` guard actually catches.
    const response = await run("/%2e%2e%2f%2e%2e%2fetc%2fpasswd");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("root:");
  });
});
