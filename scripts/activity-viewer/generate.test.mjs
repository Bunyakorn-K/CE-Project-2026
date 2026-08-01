import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildViewerHtml,
  extractWorkflows,
  normalizeSvg,
  prefixSvgIds,
} from "./generate.mjs";

const sourcePath = new URL(
  "../../docs/02_architecture/data-and-activity-diagrams.md",
  import.meta.url,
);

const minimalSvg = (id) =>
  `<svg role="img" aria-labelledby="${id}-title"><title id="${id}-title">${id}</title></svg>`;

function workflowMetadataForTest() {
  return ["telemetry", "access", "alerts", "assistant"].map((id) => ({
    id,
    title: id,
    summary: `${id} summary`,
    outcome: `${id} outcome`,
    svg: minimalSvg(id),
  }));
}

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

test("extractWorkflows fails closed when an approved workflow is duplicated", async () => {
  const markdown = await readFile(sourcePath, "utf8");
  const duplicate = [
    "## Activity Diagram 1: MQTT Telemetry Ingestion and Digital Twin Update",
    "",
    "```mermaid",
    "flowchart TD",
    "    DUPLICATE[Duplicate telemetry workflow]",
    "```",
  ].join("\n");

  assert.throws(
    () => extractWorkflows(`${markdown}\n\n${duplicate}\n`),
    /Expected 4 Activity Mermaid blocks, found 5/,
  );
});

test("extractWorkflows fails closed when an approved heading is duplicated", async () => {
  const markdown = await readFile(sourcePath, "utf8");
  const duplicateHeading =
    "## Activity Diagram 1: MQTT Telemetry Ingestion and Digital Twin Update";

  assert.throws(
    () => extractWorkflows(`${markdown}\n\n${duplicateHeading}\n`),
    /Expected exactly one heading for Activity Diagram 1.*found 2/,
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

test("prefixSvgIds rewrites every supported local fragment reference form", () => {
  const svg = [
    "<svg aria-labelledby='title desc' aria-describedby=\"desc\">",
    "<title id='title'>Example</title>",
    '<desc id="desc">Description</desc>',
    "<style>#gradient, #clip:hover{fill:url('#gradient')}#node > use{filter:url(\"#blur\")}</style>",
    "<defs><linearGradient id='gradient'/><filter id=\"blur\"/><clipPath id='clip'/>",
    "<mask id='mask'/><marker id='marker'/></defs>",
    "<path id='node' fill='#gradient' stroke=\"#gradient\" filter='#blur' clip-path=\"#clip\" mask='#mask' marker-end=\"#marker\"/>",
    "<use href='#node'/><use xlink:href=\"#node\"/>",
    "</svg>",
  ].join("");

  const output = prefixSvgIds(svg, "telemetry");

  assert.match(output, /id='telemetry-gradient'/);
  assert.match(output, /url\('#telemetry-gradient'\)/);
  assert.match(output, /url\("#telemetry-blur"\)/);
  assert.match(output, /href='#telemetry-node'/);
  assert.match(output, /xlink:href="#telemetry-node"/);
  assert.match(output, /fill='#telemetry-gradient'/);
  assert.match(output, /stroke="#telemetry-gradient"/);
  assert.match(output, /filter='#telemetry-blur'/);
  assert.match(output, /clip-path="#telemetry-clip"/);
  assert.match(output, /mask='#telemetry-mask'/);
  assert.match(output, /marker-end="#telemetry-marker"/);
  assert.match(output, /#telemetry-gradient, #telemetry-clip:hover/);
  assert.match(output, /#telemetry-node > use/);
  assert.match(output, /aria-labelledby='telemetry-title telemetry-desc'/);
  assert.match(output, /aria-describedby="telemetry-desc"/);
});

test("prefixSvgIds applies overlapping ID mappings exactly once", () => {
  const svg = [
    '<svg><g id="node"/><g id="telemetry-node"/>',
    '<use href="#node"/><use href="#telemetry-node"/></svg>',
  ].join("");

  const output = prefixSvgIds(svg, "telemetry");

  assert.match(output, /id="telemetry-node"/);
  assert.match(output, /id="telemetry-telemetry-node"/);
  assert.match(output, /href="#telemetry-node"/);
  assert.match(output, /href="#telemetry-telemetry-node"/);
  assert.doesNotMatch(output, /telemetry-telemetry-telemetry-node/);
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

test("normalizeSvg rejects non-local resource-bearing attributes", () => {
  const workflow = {
    id: "telemetry",
    title: "Telemetry Ingestion and Digital Twin",
    summary: "Validate and persist branch telemetry.",
  };
  const unsafeSvgs = [
    "<svg><image href='images/machine.png'/></svg>",
    "<svg><image xlink:href='/images/machine.png'/></svg>",
    '<svg><use href="//example.com/icons.svg#machine"/></svg>',
    "<svg><use xlink:href='icons.svg#machine'/></svg>",
    "<svg><script src='javascript:alert(1)'/></svg>",
    "<svg><image href=data:image/svg+xml;base64,PHN2Zy8+/></svg>",
    "<svg><image data-note='>' href='images/machine.png'/></svg>",
  ];

  for (const svg of unsafeSvgs) {
    assert.throws(() => normalizeSvg(svg, workflow), /External resource/, svg);
  }
});

test("normalizeSvg allows local fragment resource references", () => {
  const workflow = {
    id: "telemetry",
    title: "Telemetry Ingestion and Digital Twin",
    summary: "Validate and persist branch telemetry.",
  };

  assert.doesNotThrow(() => normalizeSvg(
    "<svg><defs><g id='machine'/></defs><use href='#machine'/></svg>",
    workflow,
  ));
});

test("normalizeSvg generates collision-free accessibility metadata IDs", () => {
  const workflow = {
    id: "telemetry",
    title: "Telemetry Ingestion and Digital Twin",
    summary: "Validate and persist branch telemetry.",
  };
  const svg = [
    '<svg><title id="svg-title">Source title</title>',
    '<desc id="svg-desc">Source description</desc>',
    '<g aria-labelledby="svg-title svg-desc"/></svg>',
  ].join("");

  const output = normalizeSvg(svg, workflow);
  const ids = [...output.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);

  assert.equal(ids.length, new Set(ids).size);
  assert.match(output, /<title id="telemetry-svg-title-2">/);
  assert.match(output, /<desc id="telemetry-svg-desc-2">/);
  assert.match(
    output,
    /aria-labelledby="telemetry-svg-title-2 telemetry-svg-desc-2"/,
  );
  assert.match(
    output,
    /<g aria-labelledby="telemetry-svg-title telemetry-svg-desc"\/>/,
  );
});

test("buildViewerHtml creates overview and four selectable workflows", () => {
  const workflows = [
    ["telemetry", "Telemetry"],
    ["access", "Access"],
    ["alerts", "Alerts"],
    ["assistant", "Assistant"],
  ].map(([id, title]) => ({
    id,
    title,
    summary: `${title} summary`,
    outcome: `${title} outcome`,
    svg: minimalSvg(id),
  }));

  const html = buildViewerHtml(workflows, minimalSvg("overview"));

  assert.equal((html.match(/role="tab"/g) ?? []).length, 5);
  assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 5);
  assert.match(html, /data-view="overview"[^>]*aria-selected="true"/);
  assert.match(html, /data-action="zoom-in"/);
  assert.match(html, /data-action="zoom-out"/);
  assert.match(html, /data-action="reset"/);
  assert.match(html, /window\.print\(\)/);
});

test("buildViewerHtml is self-contained", () => {
  const workflows = workflowMetadataForTest();
  const html = buildViewerHtml(workflows, minimalSvg("overview"));

  assert.doesNotMatch(html, /<(?:script|link|img)\b[^>]*(?:src|href)="https?:/i);
  assert.doesNotMatch(html, /\bfetch\s*\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage/);
  assert.match(html, /@media print/);
  assert.match(html, /prefers-reduced-motion/);
});
