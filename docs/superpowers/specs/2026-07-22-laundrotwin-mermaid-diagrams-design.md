# LaundroTwin MVP Mermaid Diagrams Design

## Goal

Add an English-language architecture document containing one target-MVP Entity
Relationship diagram and four focused Activity diagrams. The diagrams must be
useful in the CE Project report while remaining concrete enough to guide later
database and workflow implementation.

## Scope

The diagrams describe the target LaundroTwin MVP, not only the tables currently
implemented by LaundryGo. Current implementation status remains documented in
the repository README.

The document will contain:

1. A comprehensive ER diagram covering tenancy and RBAC, branches and machines,
   versioned register mappings, normalized telemetry, operational events,
   alerting, audit history, and safe AI analytics calls.
2. MQTT Telemetry Ingestion and Digital Twin Update activity flow.
3. Dashboard Access and Branch-Scoped RBAC activity flow.
4. Rule-Based Alert Evaluation and LINE Delivery activity flow.
5. Safe AI Executive Assistant Function Calling activity flow.

## ER design boundaries

- Use Mermaid `erDiagram` syntax with English `snake_case` entity attributes.
- Show primary keys, foreign keys, and relationship cardinality.
- Model normalized source events separately from latest machine snapshots and
  derived operational records.
- Keep branch and tenant scope explicit across operational data.
- Represent paid values as integer satang and leave counter/reset semantics in
  versioned mapping or evidence instead of assuming a universal meaning.
- Model pressure readings as inputs to a low-gas estimate. Do not model pressure
  as proof of gas-leak detection.
- Record alert evidence, rule versions, cooldown/deduplication keys, delivery
  outcomes, and audit history.
- Restrict AI analytics to recorded allow-listed tool calls with authorized
  tenant and branch scope.

## Activity design boundaries

- Use Mermaid `flowchart TD` syntax because it provides readable decisions and
  responsibility-oriented subgraphs without implying unsupported UML details.
- Include rejection, quarantine, stale-data, authorization-denied, duplicate,
  cooldown, delivery-failure, and insufficient-data paths where relevant.
- Keep each diagram focused on one workflow rather than combining the entire
  platform into one unreadable flow.
- Every server-side data access path must show authentication and branch-scope
  enforcement.

## Documentation placement

Create `docs/02_architecture/data-and-activity-diagrams.md`. Add the architecture
directory to the README and AGENTS documentation indexes so future changes can
find the diagrams from the repository entry points.

## Validation

- Verify every Mermaid block with a Mermaid parser or renderer.
- Check that all relationships reference declared entities.
- Check terminology against `docs/01_requirements/`,
  `docs/03_data_contracts/`, and `docs/04_traceability/RTM_matrix.md`.
- Run Markdown whitespace checks and a staged secret scan before committing.

Application tests are not required for a diagram-only change unless another
source or configuration file changes.
