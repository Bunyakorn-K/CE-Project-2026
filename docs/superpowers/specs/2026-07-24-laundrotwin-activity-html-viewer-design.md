# LaundroTwin Activity Diagram Offline HTML Viewer Design

## Goal

Create one self-contained English-language HTML file that presents the four
target LaundroTwin MVP activity workflows at a readable scale. A user must be
able to double-click the file and use the complete viewer without a web server,
internet access, package installation, or browser extension.

The HTML viewer supplements the editable draw.io and Mermaid sources. It does
not replace the architecture requirements or change workflow semantics.

## Current problem

The current draw.io Activity page combines four detailed Mermaid workflows into
one graph with 113 vertices, 111 edges, and a rendered height of approximately
6,717 pixels. The result requires excessive zooming and makes labels and
decision paths difficult to follow.

## Approaches considered

### Selected: pre-rendered inline SVG with a small local viewer

Render each approved Mermaid workflow to SVG during development, embed the SVG
markup directly in one HTML file, and use small inline CSS and JavaScript for
navigation and zoom controls.

- Works offline from a `file://` URL.
- Does not ship a large Mermaid runtime.
- Preserves text as searchable and selectable SVG content.
- Keeps runtime behavior simple and testable.
- Requires regeneration when a source Mermaid workflow changes.

### Rejected: Mermaid runtime embedded in the HTML

Bundle the Mermaid JavaScript runtime and render diagrams when the file opens.
This keeps Mermaid source directly in the artifact, but substantially increases
file size and runtime complexity for a read-only presentation.

### Rejected: Mermaid loaded from a CDN

Load Mermaid from a public CDN when the file opens. This is the smallest source
file, but it violates the explicit offline requirement and introduces an
external availability and version dependency.

## Viewer structure

The artifact will be:

`docs/02_architecture/laundrotwin-activity-diagrams.html`

It will contain:

1. A compact overview showing the relationship among the four workflows.
2. Four workflow selectors:
   - Telemetry Ingestion and Digital Twin
   - Dashboard Access and Branch-Scoped RBAC
   - Alert Evaluation and LINE Delivery
   - Safe AI Executive Assistant
3. One visible detailed diagram at a time.
4. A short workflow purpose and outcome adjacent to the selected diagram.
5. Zoom in, zoom out, reset, and print controls.

The overview is the default view. Selecting a workflow replaces the visible
diagram instead of stacking all diagrams vertically.

## Diagram content

The four detailed diagrams will retain the existing authoritative decisions,
failure paths, and responsibility groupings from
`docs/02_architecture/data-and-activity-diagrams.md`.

Presentation may shorten labels and visually group repeated rejection outcomes,
but it must not remove these controls:

- authentication and tenant or branch authorization;
- duplicate and invalid telemetry rejection;
- stale or offline Digital Twin state;
- alert deduplication, cooldown, retry, and audit outcomes;
- allow-listed AI tools, strict argument validation, authorized scope, and
  insufficient-data handling.

The source Markdown remains the complete semantic reference. The HTML must link
each displayed workflow to its corresponding heading in that local source file
using a relative path.

## Interaction and accessibility

- Use semantic buttons for view selection and controls.
- Support keyboard navigation and visible focus indicators.
- Mark the selected workflow with `aria-selected`.
- Give every embedded SVG an accessible title and description.
- Preserve text contrast in light and dark operating-system themes.
- Reflow controls and descriptive text on narrow screens.
- Keep the diagram canvas horizontally scrollable only when its readable minimum
  width cannot fit the viewport.
- Respect reduced-motion preferences.

## Offline and security boundaries

- Include all CSS, JavaScript, SVG, fonts, and icons in the HTML file.
- Do not use CDN assets, network requests, analytics, storage, cookies, or
  service workers.
- Do not embed credentials, customer data, production values, or live telemetry.
- JavaScript controls only presentation state and does not mutate diagram data.

## Source and regeneration workflow

1. Read the four Mermaid blocks from
   `docs/02_architecture/data-and-activity-diagrams.md`.
2. Render deterministic SVG files with the pinned one-shot command
   `npx -y @mermaid-js/mermaid-cli@11.16.0`.
3. Sanitize and embed the SVG markup into the HTML artifact.
4. Keep the generated HTML committed so reviewers can open it without a build.
5. Regenerate the HTML whenever an authoritative Activity Mermaid block changes.

No application runtime code in `apps/api` or `apps/web` is involved.

## Failure handling

- The committed HTML must contain the rendered diagrams, so runtime rendering
  failure is impossible.
- If generation fails, leave the last committed HTML unchanged and fail the
  verification command.
- Missing workflow headings, empty SVGs, duplicate element IDs, or external
  resource references are release-blocking validation failures.
- Print styling must show the overview followed by all four workflows, regardless
  of the currently selected screen view.

## Validation

- Open the HTML directly from the filesystem with network access disabled.
- Verify overview and all four workflow selectors.
- Verify zoom, reset, keyboard selection, and print layout.
- Check at desktop and mobile viewport widths.
- Confirm there are no external resource URLs or network requests.
- Confirm every required control and failure path appears in the embedded SVGs.
- Run an HTML parser, JavaScript syntax check, link check, and repository
  whitespace check.

Application test suites are not required because this is an architecture
presentation artifact, but repository changes outside the architecture
documentation directory would require their normal verification.

## Out of scope

- Editing diagrams inside the HTML viewer.
- Synchronizing automatically with Google Drive or draw.io.
- Replacing the existing `.drawio` file or Mermaid source.
- Adding telemetry, machine commands, payments, or application behavior.
