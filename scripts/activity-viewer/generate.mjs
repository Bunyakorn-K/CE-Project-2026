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
