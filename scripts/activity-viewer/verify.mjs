import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function verifyVerifierGuards() {
  assert.deepEqual(
    extractIds([
      '<svg id = "double-quoted"></svg>',
      "<g id\n=\t'single-quoted'></g>",
      "<path id=unquoted></path>",
      '<path data-id="ignored"></path>',
    ].join("")),
    ["double-quoted", "single-quoted", "unquoted"],
  );

  for (const [label, markup] of [
    ["quoted remote asset", '<img src = " https://example.com/image.svg">'],
    ["unquoted remote asset", "<link href=//example.com/styles.css>"],
    ["non-fragment SVG use", '<use xlink:href = "icons.svg#machine">'],
    ["remote CSS import", "<style>@import url ( 'https://example.com/a.css' );</style>"],
    ["remote CSS URL", "<style>.icon { background: url( //example.com/a.svg ); }</style>"],
    ["remote form action", "<form action = https://example.com/submit>"],
    ["refresh redirect", '<meta http-equiv = " refresh" content="0">'],
    ["network primitive", 'fetch ("/api")'],
    ["browser storage", "document . cookie"],
  ]) {
    assert.throws(
      () => assertSelfContained(markup),
      /violates the offline self-contained contract/,
      label,
    );
  }
}

verifyVerifierGuards();

const viewerUrl = new URL(
  "../../docs/02_architecture/laundrotwin-activity-diagrams.html",
  import.meta.url,
);
const viewer = await readFile(viewerUrl, "utf8");

function extractIds(markup) {
  return [...markup.matchAll(
    /(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
  )].map((match) => match[1] ?? match[2] ?? match[3]);
}

function assertSelfContained(markup) {
  for (const [label, pattern] of [
    [
      "external asset-bearing element",
      /<(?:script|link|img|image|iframe|object|embed|audio|video|source|track|input)\b[^>]*\s(?:src|href|xlink:href|data|poster|srcset)\s*=/i,
    ],
    [
      "non-fragment SVG use",
      /<use\b[^>]*\s(?:href|xlink:href)\s*=\s*(?:["']\s*)?(?!#)[^"'\s>]+/i,
    ],
    [
      "remote resource attribute",
      /\s(?:src|href|xlink:href|data|poster|srcset|action|formaction|ping|manifest)\s*=\s*(?:["']\s*)?(?:[a-z][a-z0-9+.-]*:|\/\/)/i,
    ],
    [
      "remote CSS resource",
      /(?:@import\s+(?:url\s*\(\s*)?(?:["']\s*)?(?:[a-z][a-z0-9+.-]*:|\/\/)|url\s*\(\s*(?:["']\s*)?(?:[a-z][a-z0-9+.-]*:|\/\/))/i,
    ],
    [
      "embedded document or refresh redirect",
      /<(?:iframe|object|embed)\b|<meta\b[^>]*\bhttp-equiv\s*=\s*(?:["']\s*)?refresh\b/i,
    ],
    [
      "network or browser storage primitive",
      /\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon\s*\(|localStorage|sessionStorage|indexedDB|cookieStore|serviceWorker|caches\s*\.|document\s*\.\s*cookie)/i,
    ],
  ]) {
    assert.doesNotMatch(markup, pattern, `${label} violates the offline self-contained contract`);
  }
}

assert.match(viewer, /^<!doctype html>/i);
assert.equal((viewer.match(/role="tab"/g) ?? []).length, 5);
assert.equal((viewer.match(/role="tabpanel"/g) ?? []).length, 5);

for (const marker of [
  "Telemetry sample generated",
  "Requested tenant and branches authorized",
  "cooldown dedupe key",
  "Tool is allow-listed",
]) {
  assert.match(viewer, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

assertSelfContained(viewer);

const ids = extractIds(viewer);
assert.equal(new Set(ids).size, ids.length, "duplicate HTML or SVG id");
assert.equal(ids.length, 327, "unexpected actual HTML or SVG id count");

for (const reference of [
  "data-and-activity-diagrams.md",
  'data-action="zoom-in"',
  'data-action="zoom-out"',
  'data-action="reset"',
  "@media print",
  "prefers-reduced-motion",
]) {
  assert.ok(viewer.includes(reference), `missing ${reference}`);
}

console.log(`Verified ${ids.length} unique IDs across 5 offline diagrams.`);
