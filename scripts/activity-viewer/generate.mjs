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
