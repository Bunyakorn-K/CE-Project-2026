import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import * as generator from "./generate.mjs";

const {
  buildViewerHtml,
  extractWorkflows,
  normalizeSvg,
  outputPath,
  prefixSvgIds,
} = generator;

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

const externalResourceElementPattern =
  /<(?:script|link|img|image|iframe|object|embed|audio|video|source|track|input)\b[^>]*\s(?:src|href|xlink:href|data|poster|srcset)\s*=/i;
const remoteResourceAttributePattern =
  /\s(?:src|href|xlink:href|data|poster|srcset|action|formaction|ping|manifest)\s*=\s*(?:["']\s*)?(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const externalCssResourcePattern =
  /(?:@import\s+(?:url\(\s*)?(?:["']\s*)?(?:[a-z][a-z0-9+.-]*:|\/\/)|url\(\s*(?:["']\s*)?(?:[a-z][a-z0-9+.-]*:|\/\/))/i;
const prohibitedResourceElementPattern =
  /<(?:iframe|object|embed)\b|<meta\b[^>]*\bhttp-equiv\s*=\s*(?:["']\s*)?refresh\b/i;
const prohibitedBrowserPrimitivePattern =
  /\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon\s*\(|localStorage|sessionStorage|indexedDB|cookieStore|serviceWorker|caches\s*\.|document\s*\.\s*cookie)/i;
const offlineGuardPatterns = [
  externalResourceElementPattern,
  remoteResourceAttributePattern,
  externalCssResourcePattern,
  prohibitedResourceElementPattern,
  prohibitedBrowserPrimitivePattern,
];

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

test("normalizeSvg removes only the renderer root style and preserves sizing", () => {
  const workflow = {
    id: "telemetry",
    title: "Telemetry Ingestion and Digital Twin",
    summary: "Validate and persist branch telemetry.",
  };
  const svg = [
    '<svg width="100%" viewBox="0 0 800 600"',
    ' style="max-width: 800px; background-color: transparent;">',
    '<g style="fill: currentColor"><text>Valid</text></g>',
    '</svg>',
  ].join("");

  const output = normalizeSvg(svg, workflow);
  const root = output.match(/^<svg\b[^>]*>/)?.[0];

  assert.ok(root);
  assert.doesNotMatch(root, /\sstyle\s*=/i);
  assert.match(root, /\swidth="100%"/);
  assert.match(root, /\sviewBox="0 0 800 600"/);
  assert.match(output, /<g style="fill: currentColor">/);
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

test("buildViewerHtml emits validator-safe document and control semantics", () => {
  const html = buildViewerHtml(
    workflowMetadataForTest(),
    minimalSvg("overview"),
  );

  assert.match(html, /^<!DOCTYPE html>/);
  assert.equal(
    (html.match(/<div class="viewer-controls" role="group" aria-label=/g) ?? []).length,
    5,
  );
});

test("buildViewerHtml scales percentage and minimum widths for each panel zoom", () => {
  const html = buildViewerHtml(
    workflowMetadataForTest(),
    minimalSvg("overview"),
  );

  assert.match(html, /--diagram-width:\s*100%/);
  assert.match(html, /--diagram-min-width-wide:\s*44rem/);
  assert.match(html, /--diagram-min-width-narrow:\s*38rem/);
  assert.match(html, /width:\s*var\(--diagram-width\)/);
  assert.match(html, /min-width:\s*var\(--diagram-min-width-wide\)/);
  assert.match(html, /min-width:\s*var\(--diagram-min-width-narrow\)/);
  assert.match(html, /setProperty\("--diagram-width"/);
  assert.match(html, /setProperty\("--diagram-min-width-wide"/);
  assert.match(html, /setProperty\("--diagram-min-width-narrow"/);
  assert.doesNotMatch(html, /\.style\.width\s*=/);
});

test("temporary output paths are unique siblings of the published artifact", () => {
  assert.equal(typeof generator.createTemporaryOutputPath, "function");

  const first = generator.createTemporaryOutputPath(outputPath);
  const second = generator.createTemporaryOutputPath(outputPath);

  assert.notEqual(first, second);
  assert.notEqual(first, outputPath);
  assert.notEqual(second, outputPath);
  assert.equal(dirname(first), dirname(outputPath));
  assert.equal(dirname(second), dirname(outputPath));
  assert.match(first, /\.html\.[0-9a-f-]+\.tmp$/);
  assert.match(second, /\.html\.[0-9a-f-]+\.tmp$/);
});

test("renderer configuration uses a deterministic Mermaid hand-drawn seed", () => {
  assert.deepEqual(generator.mermaidConfiguration, { handDrawnSeed: 42 });
  assert.notEqual(generator.mermaidConfiguration.handDrawnSeed, 0);
});

test("buildViewerHtml is self-contained", () => {
  const workflows = workflowMetadataForTest();
  const html = buildViewerHtml(workflows, minimalSvg("overview"));
  const prohibitedSamples = [
    '<script src="https://example.com/viewer.js"></script>',
    "<link href='//example.com/viewer.css' rel='stylesheet'>",
    '<img src="./machine.png">',
    "<svg><image xlink:href='data:image/png;base64,AA=='></image></svg>",
    '<iframe srcdoc="unsafe"></iframe>',
    '<meta http-equiv="refresh" content="0;url=https://example.com">',
    '<style>@import "https://example.com/viewer.css";</style>',
    "<style>.diagram{background:url('//example.com/image.png')}</style>",
    '<a ping="https://example.com/audit">remote</a>',
    'fetch("/api")',
    "new XMLHttpRequest()",
    'new WebSocket("wss://example.com")',
    'new EventSource("/events")',
    'navigator.sendBeacon("/audit")',
    "localStorage.viewer = 'state'",
    "sessionStorage.viewer = 'state'",
    'indexedDB.open("viewer")',
    'document.cookie = "viewer=state"',
    'cookieStore.get("viewer")',
    'navigator.serviceWorker.register("/worker.js")',
    'caches.open("viewer")',
  ];

  for (const pattern of offlineGuardPatterns) {
    assert.doesNotMatch(html, pattern);
  }
  for (const sample of prohibitedSamples) {
    assert.ok(
      offlineGuardPatterns.some((pattern) => pattern.test(sample)),
      `Offline guard missed: ${sample}`,
    );
  }
  assert.match(
    html,
    /<a href="\.\/data-and-activity-diagrams\.md">data-and-activity-diagrams\.md<\/a>/,
  );
  assert.match(html, /@media print/);
  assert.match(html, /prefers-reduced-motion/);
});
