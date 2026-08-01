import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const viewerUrl = new URL(
  "../../docs/02_architecture/laundrotwin-activity-diagrams.html",
  import.meta.url,
);
const viewer = await readFile(viewerUrl, "utf8");

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

assert.doesNotMatch(
  viewer,
  /<(?:script|link|img|image|use)\b[^>]*(?:src|href|xlink:href)="(?:https?:)?\/\//i,
);
assert.doesNotMatch(
  viewer,
  /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*(?:\(|\{)/,
);
assert.doesNotMatch(viewer, /\b(?:localStorage|sessionStorage|document\.cookie)\b/);

const ids = [...viewer.matchAll(/(?:^|\s)id="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "duplicate HTML or SVG id");

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
