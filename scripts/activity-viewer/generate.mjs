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

const overviewSource = `flowchart LR
  EDGE["Branch telemetry"] --> TELEMETRY["1. Ingest and update Digital Twin"]
  USER["Authorized user"] --> ACCESS["2. Authorize dashboard access"]
  TELEMETRY --> ALERTS["3. Evaluate and deliver alerts"]
  ACCESS --> ASSISTANT["4. Run safe analytics assistant"]
  TELEMETRY --> ACCESS
  ALERTS --> USER
  ASSISTANT --> USER`;

export function extractWorkflows(markdown) {
  const matchesByWorkflow = workflowMetadata.map((metadata) => {
    const escapedHeading = metadata.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headingPattern = new RegExp("^## " + escapedHeading + "$", "gm");
    const pattern = new RegExp(
      "^## " + escapedHeading + "\\n\\n```mermaid\\n([\\s\\S]*?)\\n```",
      "gm",
    );
    return {
      headingCount: [...markdown.matchAll(headingPattern)].length,
      matches: [...markdown.matchAll(pattern)],
      metadata,
    };
  });
  const matchCount = matchesByWorkflow.reduce(
    (total, { matches }) => total + matches.length,
    0,
  );

  if (matchCount !== workflowMetadata.length) {
    throw new Error(
      `Expected ${workflowMetadata.length} Activity Mermaid blocks, found ${matchCount}`,
    );
  }

  const invalidHeading = matchesByWorkflow.find(({ headingCount }) => headingCount !== 1);
  if (invalidHeading) {
    throw new Error(
      `Expected exactly one heading for ${invalidHeading.metadata.heading}, found ${invalidHeading.headingCount}`,
    );
  }

  const invalidWorkflow = matchesByWorkflow.find(({ matches }) => matches.length !== 1);
  if (invalidWorkflow) {
    throw new Error(
      `Expected exactly one Mermaid block for ${invalidWorkflow.metadata.heading}, found ${invalidWorkflow.matches.length}`,
    );
  }

  return matchesByWorkflow.map(({ matches, metadata }) => ({
    ...metadata,
    source: matches[0][1].trim(),
  }));
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function assertLocalResources(svg, workflow) {
  const resourceElements = svg.matchAll(
    /<(?:image|script|use)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi,
  );

  for (const [, attributes] of resourceElements) {
    const resourceAttributes = attributes.matchAll(
      /(?:^|\s)(?:href|xlink:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
    );
    for (const match of resourceAttributes) {
      const value = match[1] ?? match[2] ?? match[3];
      if (!/^#[A-Za-z_][\w:.-]*$/.test(value)) {
        throw new Error(`External resource found in ${workflow.id} SVG`);
      }
    }
  }
}

export function prefixSvgIds(svg, prefix) {
  const ids = [...new Set(
    [...svg.matchAll(/\sid\s*=\s*(["'])([^"']+)\1/g)].map((match) => match[2]),
  )].sort();
  const idMap = new Map(ids.map((id) => [id, `${prefix}-${id}`]));
  const rewriteId = (id) => idMap.get(id) ?? id;
  let output = svg.replace(
    /(\sid\s*=\s*)(["'])([^"']+)\2/g,
    (full, attribute, quote, id) => `${attribute}${quote}${rewriteId(id)}${quote}`,
  );

  output = output
    .replace(
      /url\(\s*(["']?)#([^"')\s]+)\1\s*\)/gi,
      (full, quote, id) => full.replace(`#${id}`, `#${rewriteId(id)}`),
    )
    .replace(
      /(\s(?:href|xlink:href)\s*=\s*)(["'])#([^"']+)\2/gi,
      (full, attribute, quote, id) => `${attribute}${quote}#${rewriteId(id)}${quote}`,
    )
    .replace(
      /(\s(?:fill|stroke|filter|clip-path|mask|marker-start|marker-mid|marker-end)\s*=\s*)(["'])#([^"']+)\2/gi,
      (full, attribute, quote, id) => `${attribute}${quote}#${rewriteId(id)}${quote}`,
    )
    .replace(
      /(\s(?:aria-labelledby|aria-describedby)\s*=\s*)(["'])([^"']*)\2/gi,
      (full, attribute, quote, value) => {
        const rewritten = value
          .split(/\s+/)
          .map((token) => rewriteId(token))
          .join(" ");
        return `${attribute}${quote}${rewritten}${quote}`;
      },
    );

  if (ids.length > 0) {
    const idAlternation = ids
      .sort((a, b) => b.length - a.length)
      .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    const selectorPattern = new RegExp(
      `#(${idAlternation})(?=[\\s.{,:>\\[+~#)])`,
      "g",
    );
    output = output.replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
      (full, opening, css, closing) => {
        const rewrittenCss = css.replace(
          selectorPattern,
          (match, id) => `#${rewriteId(id)}`,
        );
        return `${opening}${rewrittenCss}${closing}`;
      },
    );
  }

  return output;
}

export function normalizeSvg(svg, workflow) {
  assertLocalResources(svg, workflow);

  let output = svg
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .trim();
  output = prefixSvgIds(output, workflow.id);
  const usedIds = new Set(
    [...output.matchAll(/\sid\s*=\s*(["'])([^"']+)\1/g)].map((match) => match[2]),
  );
  const reserveId = (base) => {
    let candidate = base;
    let suffix = 2;
    while (usedIds.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(candidate);
    return candidate;
  };
  const titleId = reserveId(`${workflow.id}-svg-title`);
  const descriptionId = reserveId(`${workflow.id}-svg-desc`);
  output = output.replace(
    /<svg\b([^>]*)>/,
    (full, attributes) => {
      const cleanAttributes = attributes.replace(
        /\s(?:role|aria-labelledby|aria-describedby|preserveAspectRatio)="[^"]*"/g,
        "",
      );
      return `<svg${cleanAttributes} role="img" aria-labelledby="${titleId} ${descriptionId}" preserveAspectRatio="xMidYMin meet">`
        + `<title id="${titleId}">${escapeHtml(workflow.title)}</title>`
        + `<desc id="${descriptionId}">${escapeHtml(workflow.summary)}</desc>`;
    },
  );

  return output;
}

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
[role=tab][aria-selected="true"] { background: var(--accent); color: var(--surface); border-color: var(--accent); }
[role=tabpanel][hidden] { display: none; }
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
  [role=tabpanel][hidden] { display: block !important; }
  [role=tabpanel] { break-after: page; }
  .diagram-frame { overflow: visible; border: 0; }
  .diagram-surface { min-width: 0; width: 100% !important; padding: 0; }
}`;

const viewerScript = String.raw`
const tabs = [...document.querySelectorAll('[role=tab]')];
const panels = [...document.querySelectorAll('[role=tabpanel]')];
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
  const panel = control.closest('[role=tabpanel]');
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
      aria-controls="panel-${view.id}" data-view="${view.id}"
      aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">
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
