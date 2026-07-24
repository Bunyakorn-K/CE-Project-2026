# LaundroTwin Activity Diagram Offline HTML Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a committed, self-contained offline HTML viewer that presents the LaundroTwin overview and four Activity workflows at a readable scale.

**Architecture:** A Node.js generator extracts the four authoritative Mermaid blocks from the architecture Markdown, renders five SVGs with Mermaid CLI 11.16.0, prefixes SVG IDs, and atomically embeds them in one HTML file. The generated viewer uses only inline HTML, CSS, JavaScript, and SVG; native tabs expose one workflow at a time while print CSS exposes all diagrams.

**Tech Stack:** Node.js 22+, built-in `node:test`, Mermaid CLI 11.16.0, semantic HTML, inline SVG, CSS, vanilla JavaScript, html-validate 11.5.6

## Global Constraints

- The viewer must open completely from `file://` without a server or internet connection.
- Include no CDN asset, remote font, network request, analytics, storage, cookie, or service worker.
- Keep `docs/02_architecture/data-and-activity-diagrams.md` as the semantic source of truth.
- Preserve authentication, tenant/branch authorization, telemetry rejection, stale/offline state, alert deduplication/retry/audit, and safe-AI validation paths.
- Keep the viewer in English and responsive at desktop and mobile widths.
- Preserve visible keyboard focus, tab semantics, accessible SVG titles/descriptions, and reduced-motion preferences.
- Print the overview followed by all four workflows.
- Do not replace, stage, or commit the untracked `docs/02_architecture/laundrotwin-mvp-diagrams.drawio`.
- Do not modify application runtime code under `apps/api` or `apps/web`.

---

## File structure

- Create `scripts/activity-viewer/generate.mjs`: extract source workflows, invoke the pinned renderer, normalize SVGs, and atomically write the viewer.
- Create `scripts/activity-viewer/generate.test.mjs`: unit tests for extraction, ID prefixing, offline output, and viewer structure.
- Create `scripts/activity-viewer/verify.mjs`: release checks against the generated artifact and authoritative source.
- Create `docs/02_architecture/laundrotwin-activity-diagrams.html`: generated, self-contained viewer.
- Modify `docs/02_architecture/data-and-activity-diagrams.md`: add a relative link to the offline viewer.
- Modify `README.md`: make the viewer discoverable from the repository layout.
- Modify `package.json`: add repeatable generation and verification commands without adding a dependency.

---

### Task 1: Extract and normalize authoritative diagram sources

**Files:**
- Create: `scripts/activity-viewer/generate.mjs`
- Create: `scripts/activity-viewer/generate.test.mjs`

**Interfaces:**
- Consumes: UTF-8 content from `docs/02_architecture/data-and-activity-diagrams.md`
- Produces: `extractWorkflows(markdown) -> Array<{id, heading, title, summary, outcome, source}>`
- Produces: `prefixSvgIds(svg, prefix) -> string`
- Produces: `normalizeSvg(svg, workflow) -> string`

- [ ] **Step 1: Write failing extraction and SVG normalization tests**

Create `scripts/activity-viewer/generate.test.mjs` with these initial tests:

```js
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
```

- [ ] **Step 2: Run the focused tests and verify the red state**

Run:

```bash
node --test scripts/activity-viewer/generate.test.mjs
```

Expected: FAIL because `scripts/activity-viewer/generate.mjs` does not exist.

- [ ] **Step 3: Implement workflow metadata and extraction**

Start `scripts/activity-viewer/generate.mjs` with:

```js
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "../..");

export const sourcePath = join(
  repositoryRoot,
  "docs/02_architecture/data-and-activity-diagrams.md",
);
export const outputPath = join(
  repositoryRoot,
  "docs/02_architecture/laundrotwin-activity-diagrams.html",
);

const workflowMetadata = [
  {
    id: "telemetry",
    heading: "Activity Diagram 1: MQTT Telemetry Ingestion and Digital Twin Update",
    title: "Telemetry Ingestion and Digital Twin",
    summary: "Validate, normalize, and persist branch telemetry before updating the live Digital Twin.",
    outcome: "Authorized users see verified, fresh machine state or an explicit stale/offline state.",
  },
  {
    id: "access",
    heading: "Activity Diagram 2: Dashboard Access and Branch-Scoped RBAC",
    title: "Dashboard Access and Branch-Scoped RBAC",
    summary: "Authenticate the user and enforce tenant, branch, role, and field scope on every read and stream.",
    outcome: "The browser receives only authorized data with traceable freshness.",
  },
  {
    id: "alerts",
    heading: "Activity Diagram 3: Rule-Based Alert Evaluation and LINE Delivery",
    title: "Alert Evaluation and LINE Delivery",
    summary: "Evaluate versioned rules, suppress duplicates, deliver LINE alerts, and record every outcome.",
    outcome: "Authorized recipients receive actionable alerts without repeated notification spam.",
  },
  {
    id: "assistant",
    heading: "Activity Diagram 4: Safe AI Executive Assistant Function Calling",
    title: "Safe AI Executive Assistant",
    summary: "Authorize a question, validate an allow-listed analytics call, and answer from traceable results only.",
    outcome: "The user receives a scoped answer or an explicit denial or insufficient-data result.",
  },
];

export function extractWorkflows(markdown) {
  const workflows = workflowMetadata.flatMap((metadata) => {
    const escapedHeading = metadata.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      "^## " + escapedHeading + "\\n\\n```mermaid\\n([\\s\\S]*?)\\n```",
      "m",
    );
    const match = markdown.match(pattern);
    return match ? [{ ...metadata, source: match[1].trim() }] : [];
  });

  if (workflows.length !== workflowMetadata.length) {
    throw new Error(
      `Expected ${workflowMetadata.length} Activity Mermaid blocks, found ${workflows.length}`,
    );
  }

  return workflows;
}
```

- [ ] **Step 4: Implement ID prefixing and SVG normalization**

Add these functions to `generate.mjs`:

```js
function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function prefixSvgIds(svg, prefix) {
  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  let output = svg;

  for (const id of [...new Set(ids)].sort((a, b) => b.length - a.length)) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output
      .replace(new RegExp(`id="${escapedId}"`, "g"), `id="${prefix}-${id}"`)
      .replace(new RegExp(`url\\(#${escapedId}\\)`, "g"), `url(#${prefix}-${id})`)
      .replace(new RegExp(`(href|xlink:href)="#${escapedId}"`, "g"), `$1="#${prefix}-${id}"`)
      .replace(
        new RegExp(`#${escapedId}(?=[\\s.{,:>\\[])`, "g"),
        `#${prefix}-${id}`,
      )
      .replace(
        new RegExp(`(aria-labelledby|aria-describedby)="([^"]*)"`, "g"),
        (full, attribute, value) => {
          const rewritten = value
            .split(/\s+/)
            .map((token) => (token === id ? `${prefix}-${token}` : token))
            .join(" ");
          return `${attribute}="${rewritten}"`;
        },
      );
  }

  return output;
}

export function normalizeSvg(svg, workflow) {
  if (/<(?:image|script|use)\b[^>]*(?:href|src)="(?:https?:)?\/\//i.test(svg)) {
    throw new Error(`External resource found in ${workflow.id} SVG`);
  }

  let output = svg
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .trim();
  output = prefixSvgIds(output, workflow.id);
  output = output.replace(
    /<svg\b([^>]*)>/,
    (full, attributes) => {
      const cleanAttributes = attributes.replace(
        /\s(?:role|aria-labelledby|aria-describedby|preserveAspectRatio)="[^"]*"/g,
        "",
      );
      return `<svg${cleanAttributes} role="img" aria-labelledby="${workflow.id}-svg-title ${workflow.id}-svg-desc" preserveAspectRatio="xMidYMin meet">`
        + `<title id="${workflow.id}-svg-title">${escapeHtml(workflow.title)}</title>`
        + `<desc id="${workflow.id}-svg-desc">${escapeHtml(workflow.summary)}</desc>`;
    },
  );

  return output;
}
```

- [ ] **Step 5: Run the tests and commit Task 1**

Run:

```bash
node --test scripts/activity-viewer/generate.test.mjs
git diff --check
```

Expected: all four tests PASS and no whitespace errors.

Commit only the two Task 1 files:

```bash
git add scripts/activity-viewer/generate.mjs scripts/activity-viewer/generate.test.mjs
git commit -m "test: define activity viewer generation contract"
```

---

### Task 2: Render and build the self-contained viewer

**Files:**
- Modify: `scripts/activity-viewer/generate.mjs`
- Modify: `scripts/activity-viewer/generate.test.mjs`
- Create: `docs/02_architecture/laundrotwin-activity-diagrams.html`

**Interfaces:**
- Consumes: `extractWorkflows(markdown)` from Task 1
- Produces: `renderSvg(definition, tempDirectory) -> Promise<string>`
- Produces: `buildViewerHtml(workflows, overviewSvg) -> string`
- Produces: a complete offline HTML document at `outputPath`

- [ ] **Step 1: Add failing viewer structure and offline tests**

Append these tests to `generate.test.mjs`:

```js
import { buildViewerHtml } from "./generate.mjs";

const minimalSvg = (id) =>
  `<svg role="img" aria-labelledby="${id}-title"><title id="${id}-title">${id}</title></svg>`;

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
```

Define this helper above the tests:

```js
function workflowMetadataForTest() {
  return ["telemetry", "access", "alerts", "assistant"].map((id) => ({
    id,
    title: id,
    summary: `${id} summary`,
    outcome: `${id} outcome`,
    svg: minimalSvg(id),
  }));
}
```

- [ ] **Step 2: Run the tests and verify the new red state**

Run:

```bash
node --test scripts/activity-viewer/generate.test.mjs
```

Expected: FAIL because `buildViewerHtml` is not exported.

- [ ] **Step 3: Add the overview definition and pinned SVG renderer**

Add to `generate.mjs`:

```js
const overviewSource = `flowchart LR
  EDGE["Branch telemetry"] --> TELEMETRY["1. Ingest and update Digital Twin"]
  USER["Authorized user"] --> ACCESS["2. Authorize dashboard access"]
  TELEMETRY --> ALERTS["3. Evaluate and deliver alerts"]
  ACCESS --> ASSISTANT["4. Run safe analytics assistant"]
  TELEMETRY --> ACCESS
  ALERTS --> USER
  ASSISTANT --> USER`;

async function renderSvg(definition, name, tempDirectory) {
  const inputPath = join(tempDirectory, `${name}.mmd`);
  const svgPath = join(tempDirectory, `${name}.svg`);
  await writeFile(inputPath, definition, "utf8");
  await execFileAsync(
    "npx",
    [
      "-y",
      "@mermaid-js/mermaid-cli@11.16.0",
      "--input",
      inputPath,
      "--output",
      svgPath,
      "--backgroundColor",
      "transparent",
    ],
    { cwd: repositoryRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  const svg = await readFile(svgPath, "utf8");

  if (!svg.includes("<svg") || svg.length < 500) {
    throw new Error(`Renderer produced an empty ${name} SVG`);
  }

  return svg;
}
```

- [ ] **Step 4: Implement the HTML document and interaction contract**

Add this complete viewer implementation to `generate.mjs`:

```js
const viewerStyles = String.raw`
:root {
  color-scheme: light dark;
  --surface: light-dark(#ffffff, #15171c);
  --surface-soft: light-dark(#f4f6f8, #20232a);
  --text: light-dark(#18202a, #f1f4f8);
  --muted: light-dark(#5d6977, #aeb7c3);
  --border: light-dark(#d8dee6, #39404a);
  --accent: light-dark(#135fba, #7cb7ff);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--surface);
  color: var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
button, a { font: inherit; }
a { color: var(--accent); }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.page-shell { width: min(100%, 100rem); margin: 0 auto; padding: 2rem; }
.site-header { max-width: 62rem; margin-bottom: 1.5rem; }
.site-header h1 { margin: .25rem 0 .75rem; font-size: clamp(2rem, 5vw, 3.5rem); line-height: 1.05; }
.site-header p { color: var(--muted); line-height: 1.6; }
.eyebrow { margin: 0; color: var(--accent) !important; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.workflow-tabs { display: flex; gap: .5rem; padding: .25rem 0 1rem; overflow-x: auto; }
.workflow-tabs button, .viewer-controls button {
  border: 1px solid var(--border);
  border-radius: .65rem;
  background: var(--surface-soft);
  color: var(--text);
  cursor: pointer;
  padding: .65rem .9rem;
  white-space: nowrap;
}
[role="tab"][aria-selected="true"] { background: var(--accent); color: var(--surface); border-color: var(--accent); }
[role="tabpanel"][hidden] { display: none; }
.panel-heading { display: grid; gap: .5rem; margin-bottom: 1rem; }
.panel-heading h2 { margin: 0; font-size: clamp(1.45rem, 3vw, 2.15rem); }
.panel-heading p { margin: 0; max-width: 70rem; color: var(--muted); line-height: 1.55; }
.outcome { padding-left: .9rem; border-left: 3px solid var(--accent); }
.viewer-controls { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; margin-bottom: .75rem; }
.zoom-value { min-width: 4rem; color: var(--muted); text-align: center; font-variant-numeric: tabular-nums; }
.diagram-frame { overflow: auto; border-block: 1px solid var(--border); background: var(--surface-soft); }
.diagram-surface { width: 100%; min-width: 44rem; padding: 1rem; transform-origin: top left; }
.diagram-surface svg { display: block; width: 100%; height: auto; }
@media (max-width: 48rem) {
  .page-shell { padding: 1rem; }
  .diagram-surface { min-width: 38rem; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
}
@media print {
  .page-shell { width: 100%; padding: 0; }
  nav, .viewer-controls { display: none !important; }
  [role="tabpanel"][hidden] { display: block !important; }
  [role="tabpanel"] { break-after: page; }
  .diagram-frame { overflow: visible; border: 0; }
  .diagram-surface { min-width: 0; width: 100% !important; padding: 0; }
}`;

const viewerScript = String.raw`
const tabs = [...document.querySelectorAll('[role="tab"]')];
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
const zoomByView = new Map(panels.map((panel) => [panel.dataset.view, 1]));

function selectView(view) {
  for (const tab of tabs) {
    const selected = tab.dataset.view === view;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of panels) {
    panel.hidden = panel.dataset.view !== view;
  }
}

function setZoom(panel, value) {
  const zoom = Math.min(2, Math.max(0.6, value));
  zoomByView.set(panel.dataset.view, zoom);
  panel.querySelector(".diagram-surface").style.width = String(zoom * 100) + "%";
  panel.querySelector("[data-zoom-value]").textContent = String(Math.round(zoom * 100)) + "%";
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => selectView(tab.dataset.view));
  tab.addEventListener("keydown", (event) => {
    const keys = { ArrowRight: 1, ArrowLeft: -1 };
    if (event.key === "Home" || event.key === "End" || keys[event.key]) {
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + keys[event.key] + tabs.length) % tabs.length;
      tabs[nextIndex].focus();
      selectView(tabs[nextIndex].dataset.view);
    }
  });
}

document.addEventListener("click", (event) => {
  const control = event.target.closest("[data-action]");
  if (!control) return;
  if (control.dataset.action === "print") {
    window.print();
    return;
  }
  const panel = control.closest('[role="tabpanel"]');
  const current = zoomByView.get(panel.dataset.view);
  const next = control.dataset.action === "zoom-in"
    ? current + 0.1
    : control.dataset.action === "zoom-out"
      ? current - 0.1
      : 1;
  setZoom(panel, next);
});`;

export function buildViewerHtml(workflows, overviewSvg) {
  const views = [
    {
      id: "overview",
      title: "Workflow Overview",
      summary: "How telemetry, access control, alerting, and safe analytics connect.",
      outcome: "Select a detailed workflow to inspect its authorization, validation, and failure paths.",
      svg: overviewSvg,
    },
    ...workflows,
  ];
  const tabs = views.map((view, index) => `
    <button id="tab-${view.id}" role="tab" type="button"
      aria-controls="panel-${view.id}" aria-selected="${index === 0}"
      tabindex="${index === 0 ? 0 : -1}" data-view="${view.id}">
      ${escapeHtml(view.title)}
    </button>`).join("");
  const panels = views.map((view, index) => `
    <section id="panel-${view.id}" role="tabpanel"
      aria-labelledby="tab-${view.id}" data-view="${view.id}"
      ${index === 0 ? "" : "hidden"}>
      <div class="panel-heading">
        <h2>${escapeHtml(view.title)}</h2>
        <p>${escapeHtml(view.summary)}</p>
        <p class="outcome"><strong>Outcome:</strong> ${escapeHtml(view.outcome)}</p>
      </div>
      <div class="viewer-controls" aria-label="${escapeHtml(view.title)} controls">
        <button type="button" data-action="zoom-out">Zoom out</button>
        <span class="zoom-value" data-zoom-value aria-live="polite">100%</span>
        <button type="button" data-action="zoom-in">Zoom in</button>
        <button type="button" data-action="reset">Reset</button>
        <button type="button" data-action="print">Print / Save PDF</button>
      </div>
      <div class="diagram-frame">
        <div class="diagram-surface">${view.svg}</div>
      </div>
    </section>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>LaundroTwin MVP Activity Diagrams</title>
  <style>${viewerStyles}</style>
</head>
<body>
  <div class="page-shell">
    <header class="site-header">
      <p class="eyebrow">CE Project 2026</p>
      <h1>LaundroTwin MVP Activity Diagrams</h1>
      <p>Explore one workflow at a time. The complete semantic source remains in
        <a href="./data-and-activity-diagrams.md">data-and-activity-diagrams.md</a>.
      </p>
    </header>
    <nav class="workflow-tabs" role="tablist" aria-label="Activity workflow">${tabs}</nav>
    <main>${panels}</main>
  </div>
  <script>${viewerScript}</script>
</body>
</html>
`;
}
```

- [ ] **Step 5: Add atomic generation**

Add this `main()` and direct-execution guard:

```js
async function main() {
  const markdown = await readFile(sourcePath, "utf8");
  const workflows = extractWorkflows(markdown);
  const tempDirectory = await mkdtemp(join(tmpdir(), "laundrotwin-activity-"));
  const temporaryOutput = `${outputPath}.tmp`;

  try {
    const rendered = [];
    for (const workflow of workflows) {
      const svg = await renderSvg(workflow.source, workflow.id, tempDirectory);
      rendered.push({ ...workflow, svg: normalizeSvg(svg, workflow) });
    }
    const overview = {
      id: "overview",
      title: "LaundroTwin MVP Workflow Overview",
      summary: "How telemetry, access control, alerting, and safe analytics connect.",
    };
    const overviewSvg = normalizeSvg(
      await renderSvg(overviewSource, overview.id, tempDirectory),
      overview,
    );
    const html = buildViewerHtml(rendered, overviewSvg);
    await writeFile(temporaryOutput, html, "utf8");
    await rename(temporaryOutput, outputPath);
  } finally {
    await rm(temporaryOutput, { force: true });
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 6: Generate the artifact and run the focused tests**

Run:

```bash
node --test scripts/activity-viewer/generate.test.mjs
node scripts/activity-viewer/generate.mjs
test -s docs/02_architecture/laundrotwin-activity-diagrams.html
```

Expected: all tests PASS, Mermaid renders five non-empty SVGs, and the HTML file
exists without a `.tmp` sibling.

- [ ] **Step 7: Commit Task 2**

```bash
git add \
  scripts/activity-viewer/generate.mjs \
  scripts/activity-viewer/generate.test.mjs \
  docs/02_architecture/laundrotwin-activity-diagrams.html
git commit -m "docs: add offline activity diagram viewer"
```

Before committing, confirm the downloaded draw.io file is not staged:

```bash
git diff --cached --name-only | rg 'laundrotwin-mvp-diagrams\.drawio' && exit 1 || true
```

Expected: no output.

---

### Task 3: Add release verification and repository navigation

**Files:**
- Create: `scripts/activity-viewer/verify.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/02_architecture/data-and-activity-diagrams.md`

**Interfaces:**
- Consumes: generated `docs/02_architecture/laundrotwin-activity-diagrams.html`
- Produces: `pnpm docs:activity:generate`
- Produces: `pnpm docs:activity:verify`

- [ ] **Step 1: Write the verifier**

Create `scripts/activity-viewer/verify.mjs`:

```js
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

const ids = [...viewer.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
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
```

- [ ] **Step 2: Add repeatable root scripts**

Add these entries to the root `package.json` `scripts` object:

```json
"docs:activity:generate": "node scripts/activity-viewer/generate.mjs",
"docs:activity:verify": "node --test scripts/activity-viewer/generate.test.mjs && node scripts/activity-viewer/verify.mjs && npx -y html-validate@11.5.6 docs/02_architecture/laundrotwin-activity-diagrams.html"
```

Do not add a dependency or modify `pnpm-lock.yaml`.

- [ ] **Step 3: Add viewer links**

Add this note immediately below the introductory paragraph in
`docs/02_architecture/data-and-activity-diagrams.md`:

```markdown
> Open the [offline Activity diagram viewer](laundrotwin-activity-diagrams.html)
> to explore one workflow at a readable scale without a server or internet
> connection.
```

Add this entry under `docs/02_architecture/` in the README repository layout:

```text
docs/02_architecture/     Target data model, Mermaid sources, and offline Activity viewer
```

- [ ] **Step 4: Run deterministic and static verification**

Run:

```bash
pnpm docs:activity:generate
pnpm docs:activity:verify
git diff --check
git diff --exit-code -- docs/02_architecture/laundrotwin-activity-diagrams.html
```

Expected:

- generation exits `0`;
- unit tests pass;
- verifier reports five offline diagrams and unique IDs;
- html-validate reports no errors;
- regeneration leaves the committed HTML unchanged;
- no whitespace errors.

- [ ] **Step 5: Run a focused secret and external-resource scan**

Run:

```bash
rg -n -i \
  '(api[_-]?key|secret|password|token)[[:space:]]*[:=][[:space:]]*[^[:space:]]+|<(script|link|img|image|use)[^>]+(src|href|xlink:href)="(https?:)?//' \
  docs/02_architecture/laundrotwin-activity-diagrams.html
```

Expected: no output. W3C XML namespace URLs inside inline SVG are allowed because
they identify markup namespaces and do not cause network requests.

- [ ] **Step 6: Commit Task 3**

```bash
git add \
  package.json \
  README.md \
  docs/02_architecture/data-and-activity-diagrams.md \
  scripts/activity-viewer/verify.mjs
git commit -m "docs: verify and index activity viewer"
```

Expected: `pnpm-lock.yaml` and `laundrotwin-mvp-diagrams.drawio` are not staged.

---

### Task 4: Browser smoke test and final release gate

**Files:**
- Test: `docs/02_architecture/laundrotwin-activity-diagrams.html`
- Test: `scripts/activity-viewer/generate.test.mjs`
- Test: `scripts/activity-viewer/verify.mjs`

**Interfaces:**
- Consumes: the committed offline HTML artifact
- Produces: verified direct-file desktop, mobile, keyboard, zoom, and print behavior

- [ ] **Step 1: Open the file directly with network disabled**

Open:

```text
file:///Users/uunw/programming/final-project/docs/02_architecture/laundrotwin-activity-diagrams.html
```

Use browser network inspection or an offline browser context. Expected:

- the Overview is visible by default;
- no HTTP, HTTPS, WebSocket, or font request occurs;
- no console error occurs.

- [ ] **Step 2: Test all workflow selectors and keyboard behavior**

For each selector, verify the matching panel becomes visible and the previous
panel becomes hidden. Then focus the first selector and press:

```text
ArrowRight, ArrowLeft, Home, End, Enter
```

Expected: focus and `aria-selected` move consistently, exactly one panel is
visible, and every workflow contains its required marker text.

- [ ] **Step 3: Test zoom and reset**

On one detailed workflow:

1. Click Zoom In twice.
2. Confirm the value changes from `100%` to `120%`.
3. Click Zoom Out once and confirm `110%`.
4. Click Reset and confirm `100%`.
5. Confirm the diagram remains readable and the frame scrolls instead of
   clipping content.

- [ ] **Step 4: Test responsive and print layouts**

Check viewports:

```text
1440 × 900
390 × 844
```

Expected: controls remain operable, text does not overlap, and narrow screens
scroll only inside the diagram frame.

Open print preview. Expected: navigation and controls are hidden, and the
overview plus all four workflows print in order with page breaks.

- [ ] **Step 5: Run the complete repository release gate**

Run:

```bash
pnpm docs:activity:generate
pnpm docs:activity:verify
pnpm test
pnpm check
pnpm build
git diff --check
git status --short
```

Expected:

- viewer generation and verification pass;
- application tests, checks, and builds pass;
- only the intentionally untracked
  `docs/02_architecture/laundrotwin-mvp-diagrams.drawio` remains outside Git;
- no generated `.tmp`, `.mmd`, or `.svg` file remains.

- [ ] **Step 6: Review commits and report**

Run:

```bash
git log --oneline --decorate -5
git diff origin/main...HEAD --stat
git status --short
```

Report the viewer path, verification results, commit SHAs, and the unchanged
untracked draw.io copy. Do not push or upload to Google Drive unless the user
explicitly requests it.
