import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { MiddlewareHandler } from "hono";

/**
 * Serves the built SPA from the API process, so one image carries the whole
 * product instead of a static nginx container proxying to a second one.
 *
 * The web and API images were never independent. The runbook already records
 * deploying them as a pair ("API and web together because the web reads fields
 * the API change introduces"), so two image tags with two independent rollout
 * inputs described a coupling the release process did not have. One image makes
 * the constraint structural.
 *
 * WHAT THIS MUST NOT DO, and the reason each rule exists:
 *
 * 1. It must not answer a path under a server prefix with the SPA. A request
 *    to `/api/nope` is a caller mistake; replying 200 with index.html turns a
 *    typo into a silent success whose body fails to parse as JSON three
 *    layers away. `apiError` already distinguishes caller faults from source
 *    faults, and a SPA fallback would undo that by swallowing both.
 * 2. It must not answer a non-GET request with the SPA. A POST to an unknown
 *    path is a wrong URL, not a page load, and 200-with-HTML would let a LINE
 *    webhook retry loop look like it succeeded.
 * 3. It must not let a crafted path escape the web root. `normalize` plus a
 *    prefix check is what keeps `/../../etc/passwd` a 404 rather than a file
 *    disclosure. This handler reads from the filesystem, so the traversal rule
 *    is load-bearing rather than theoretical.
 *
 * The API prefixes are declared here as one list rather than inferred from the
 * registered routes: a route added later must not silently become
 * unreachable behind the SPA, and a list that a test compares against the
 * server's own route table is what makes that visible.
 */

/** Path prefixes owned by the server. A request under one is never the SPA. */
export const SERVER_PATH_PREFIXES = ["/api", "/webhooks", "/mcp", "/docs", "/health"] as const;

/**
 * Whether a request is the server's to answer rather than the SPA's.
 *
 * Extracted as a pure function because it is the whole safety argument: every
 * rule above is a branch in here, and a branch that cannot be tested directly
 * is a branch that will be wrong.
 */
export function isServerPath(path: string): boolean {
  return SERVER_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * What the SPA handler should do with a request that reached it.
 *
 * `serve` for a path that resolves inside the web root, `index` for a
 * client-side route that must boot the app, and `reject` for everything else —
 * which covers traversal attempts and any method that is not a page load.
 */
export type SpaDecision = "serve" | "index" | "reject";

/** A `..` segment, before or after decoding. */
const HAS_PARENT_SEGMENT = /(^|\/)\.\.(\/|$)/;

/**
 * Decides how to answer a request the server routes did not claim.
 *
 * `serve` is a real file in the web root, `index` is a client-side route that
 * must boot the app, and `reject` means the server keeps looking — which ends
 * in a 404.
 *
 * A `GET`/`HEAD` under a client-side route returns `index`, so a deep link like
 * `/dashboard` or `/login` survives a reload — the same job nginx's
 * `try_files $uri $uri/ /index.html` did. Anything under a server prefix is
 * rejected rather than answered, so a missing API route stays a 404 that the
 * web's `api-errors.ts` can map instead of becoming a 200 HTML page.
 *
 * The extension test is what keeps a missing bundle file a 404. Answering
 * `/assets/gone.js` with index.html renders a blank page whose only symptom is
 * a console error, and a hashed bundle name always carries an extension, so the
 * two cases never overlap.
 */
export function decideSpaResponse(path: string, method: string): SpaDecision {
  if (isServerPath(path)) return "reject";
  if (method !== "GET" && method !== "HEAD") return "reject";
  // Checked on the raw and the decoded path: a traversal attempt must not be
  // able to reach `index` by carrying no extension.
  if (HAS_PARENT_SEGMENT.test(path) || HAS_PARENT_SEGMENT.test(safeDecode(path) ?? "")) return "reject";
  return isKnownAssetPath(path) ? "serve" : "index";
}

/**
 * Resolves a URL path inside `root`, or `null` if it would escape.
 *
 * Returns null rather than clamping, because a traversal attempt is not a
 * request for a nearby file. The prefix test compares against `root + sep` so a
 * sibling directory sharing a name prefix (`/app/public-backup`) cannot pass as
 * a child of `/app/public`.
 */
export function resolveWithinRoot(root: string, path: string): string | null {
  const decoded = safeDecode(path);
  if (decoded === null) return null;
  // `normalize` collapses `..` before the prefix test, so the test below is
  // checking the resolved location rather than the literal request.
  const candidate = resolve(join(root, normalize(decoded)));
  const base = resolve(root);
  return candidate === base || candidate.startsWith(base + sep) ? candidate : null;
}

/** A malformed percent-encoding is a 404, never a thrown URIError. */
function safeDecode(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/**
 * Content types for the file kinds a Vite build emits.
 *
 * `c.body()` does not infer a MIME type — it defaults to `text/plain` — so an
 * untyped static handler serves correct HTML that a browser displays as source
 * text instead of rendering. This is why the previous nginx layer was not
 * merely redundant: it set these headers for free. Anything absent here falls
 * back to `application/octet-stream`, which downloads rather than executes, so
 * an unlisted type degrades to a broken-but-safe asset rather than an executed
 * one.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  // `apps/web/public/fonts/` ships a README.md and OFL.txt alongside the woff2,
  // and `public/` is copied verbatim into the bundle, so both are served files
  // whether or not a browser requests them. Found by the bundle test, which
  // reads the real `apps/web/dist` rather than a fixture tree — a fixture only
  // ever contains extensions its author already thought of.
  ".md": "text/markdown; charset=utf-8"
};

/** The content type for a served file, by extension. */
export function contentTypeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/**
 * Whether a path names a file this handler knows how to serve.
 *
 * Derived from `CONTENT_TYPES` rather than from a length-capped regex. The
 * earlier `/\.[a-z0-9]{2,5}$/` looked equivalent and was not: it silently missed
 * `.webmanifest` (11 characters), so a request for that file was treated as a
 * client-side route and answered with 200 index.html — a missing asset wearing
 * the one status that cannot be distinguished from success. Two facts about the
 * same set of extensions, expressed twice, is the failure mode; a cap is also
 * an open-ended promise that the next extension added to the map will satisfy,
 * which is precisely the assumption that was false.
 *
 * The trade-off is deliberate: an extension nobody has heard of is treated as a
 * route and gets the shell. That is the pre-nginx behaviour, and it is the safe
 * direction — it cannot serve a file with a wrong type, because the only files
 * served are the ones with a known type.
 */
export function isKnownAssetPath(path: string): boolean {
  return CONTENT_TYPES[extname(path).toLowerCase()] !== undefined;
}

/**
 * Builds the static + SPA-fallback middleware.
 *
 * `root` is the built web directory. It is read from disk per request rather
 * than cached so a replaced bundle is picked up without a restart, which
 * matters because the container's rollback path is a tag change, not a rebuild.
 */
export function spaHandler(root: string): MiddlewareHandler {
  const indexPath = join(root, "index.html");
  return async (c, next) => {
    const decision = decideSpaResponse(c.req.path, c.req.method);
    if (decision === "reject") return next();

    // Only the `serve` branch reads a request-derived path, so only it needs
    // the root confinement. The `index` branch reads a fixed path, which cannot
    // disclose anything regardless of what the request said.
    const target = decision === "index" ? indexPath : resolveWithinRoot(root, c.req.path);
    if (target === null) return next();

    try {
      const body = await readFile(target);
      // Hashed asset filenames are immutable; index.html must never be cached
      // or a deploy leaves browsers holding a shell that references assets which
      // no longer exist.
      const immutable = target !== indexPath;
      c.header("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
      c.header("Content-Type", contentTypeFor(target));
      return c.body(new Uint8Array(body));
    } catch {
      return next();
    }
  };
}
