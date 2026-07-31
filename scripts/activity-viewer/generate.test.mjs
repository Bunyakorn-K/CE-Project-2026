import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  extractWorkflows,
  normalizeSvg,
  prefixSvgIds,
} from "./generate.mjs";

const sourcePath = new URL(
  "../../docs/02_architecture/data-and-activity-diagrams.md",
  import.meta.url,
);

test("extractWorkflows returns the four authoritative Activity diagrams", async () => {
  const markdown = await readFile(sourcePath, "utf8");
  const workflows = extractWorkflows(markdown);

  assert.deepEqual(
    workflows.map(({ id }) => id),
    ["telemetry", "access", "alerts", "assistant"],
  );
  assert.match(workflows[0].source, /Telemetry sample generated/);
  assert.match(workflows[1].source, /Requested tenant and branches authorized/);
  assert.match(workflows[2].source, /cooldown dedupe key/);
  assert.match(workflows[3].source, /Tool is allow-listed/);
});

test("extractWorkflows fails closed when an expected heading is missing", () => {
  assert.throws(
    () => extractWorkflows("# Activity Diagram 1: incomplete"),
    /Expected 4 Activity Mermaid blocks, found 0/,
  );
});

test("prefixSvgIds rewrites IDs and local references", () => {
  const svg = [
    '<svg aria-labelledby="title desc">',
    '<title id="title">Example</title>',
    '<desc id="desc">Description</desc>',
    '<style>#arrow{fill:none}</style>',
    '<defs><marker id="arrow"/></defs>',
    '<path marker-end="url(#arrow)"/>',
    '<use href="#arrow"/>',
    "</svg>",
  ].join("");

  const output = prefixSvgIds(svg, "telemetry");

  assert.match(output, /id="telemetry-title"/);
  assert.match(output, /id="telemetry-arrow"/);
  assert.match(output, /url\(#telemetry-arrow\)/);
  assert.match(output, /href="#telemetry-arrow"/);
  assert.match(output, /#telemetry-arrow\{fill:none\}/);
  assert.match(output, /aria-labelledby="telemetry-title telemetry-desc"/);
});

test("normalizeSvg adds accessible metadata and rejects external resources", () => {
  const workflow = {
    id: "telemetry",
    title: "Telemetry Ingestion and Digital Twin",
    summary: "Validate and persist branch telemetry.",
  };
  const svg = '<svg id="diagram" role="graphics-document document"><g id="node"><text>Valid</text></g></svg>';
  const output = normalizeSvg(svg, workflow);

  assert.match(output, /role="img"/);
  assert.equal((output.match(/\brole="/g) ?? []).length, 1);
  assert.match(output, /<title id="telemetry-svg-title">/);
  assert.match(output, /<desc id="telemetry-svg-desc">/);
  assert.doesNotMatch(output, /<\?xml|<!DOCTYPE/);
  assert.throws(
    () => normalizeSvg('<svg><image href="https://example.com/a.svg"/></svg>', workflow),
    /External resource/,
  );
});
