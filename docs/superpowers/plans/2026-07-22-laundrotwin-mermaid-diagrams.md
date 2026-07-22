# LaundroTwin MVP Mermaid Diagrams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a report-ready target-MVP ER diagram and four focused Mermaid Activity diagrams for LaundroTwin.

**Architecture:** Keep all five diagrams in one architecture document so entity names and workflow terminology remain consistent. Model the durable target data in one `erDiagram`, then use four `flowchart TD` blocks with responsibility-oriented subgraphs for ingestion, access control, alerts, and safe AI analytics.

**Tech Stack:** Markdown, Mermaid `erDiagram`, Mermaid `flowchart TD`, Mermaid CLI validation

## Global Constraints

- Describe the target LaundroTwin MVP rather than claiming the current LaundryGo SQLite implementation is complete.
- Use English labels and `snake_case` database attributes.
- Use only existing MQTT, Modbus, and pressure data; do not introduce new hardware.
- Pressure trends may support low-gas estimation but never gas-leak detection.
- Do not assume universal `paid_counter` or coin-box reset semantics.
- Enforce tenant and branch scope on every server-side access path.
- AI may call only allow-listed analytics functions and may not execute arbitrary SQL.

---

### Task 1: Create the architecture diagram document

**Files:**
- Create: `docs/02_architecture/data-and-activity-diagrams.md`

**Interfaces:**
- Consumes: `docs/01_requirements/system_functions.md`, `docs/01_requirements/user_stories.md`, `docs/03_data_contracts/data_contracts.md`, `docs/04_traceability/RTM_matrix.md`
- Produces: Stable entity and workflow terminology for the CE Project report

- [ ] **Step 1: Add the target-MVP ER diagram**

Declare these exact entity groups:

```text
Tenancy: TENANT, BRANCH, USER, MEMBERSHIP
Machine mapping: REGISTER_MAP, REGISTER_DEFINITION, MACHINE
Telemetry: TELEMETRY_EVENT, INGESTION_REJECTION, MACHINE_SNAPSHOT
Operations: MACHINE_CYCLE, PAYMENT_EVENT, GAS_SENSOR,
            GAS_PRESSURE_EVENT, COIN_BOX_ESTIMATE, COIN_BOX_RESET
Alerts and audit: ALERT_RULE, ALERT_EVENT, ALERT_DELIVERY, AUDIT_LOG
AI analytics: AI_REQUEST, AI_TOOL_CALL
```

Every durable operational entity must include its own primary key, required
foreign keys, event or audit timestamps, and the evidence/version fields needed
by its requirement. Use integer satang for money. Keep optional branch, machine,
sensor, and actor references explicit where one alert or audit record can target
different entity types.

- [ ] **Step 2: Add MQTT Telemetry Ingestion and Digital Twin Update**

Use subgraphs `Existing Branch Edge`, `Cloud Ingestion`, and
`Authorized Dashboard`. Include broker authentication, envelope validation,
known identity/register-map validation, duplicate detection, versioned decoding,
unit normalization, rejection storage, event persistence, snapshot update,
derived evidence, branch-scoped streaming, authorization re-check, and stale UI
handling.

- [ ] **Step 3: Add Dashboard Access and Branch-Scoped RBAC**

Use subgraphs `User and Browser`, `API Authorization`, and `Data Access`. Include
authentication failure, active-membership loading, requested-scope validation,
role permission checks, server-side tenant/branch predicates, field-level
revenue policy, denial auditing, response timestamps, and stream authorization.

- [ ] **Step 4: Add Rule-Based Alert Evaluation and LINE Delivery**

Use subgraphs `Rule Engine`, `Delivery Worker`, and `Authorized User`. Include
versioned matching rules, evidence evaluation, dedupe key construction,
cooldown suppression, durable alert creation, recipient resolution, LINE
Messaging API delivery, bounded retry, delivery outcome storage, and authorized
acknowledgement auditing.

- [ ] **Step 5: Add Safe AI Executive Assistant Function Calling**

Use subgraphs `Authorized User`, `Assistant Orchestrator`, and
`Analytics Service`. Include authentication, sanitized request recording,
allow-listed tool selection, strict argument schema validation, branch-scope
validation, parameterized analytics execution, insufficient-data handling,
tool-call auditing, and answer generation from tool results only.

- [ ] **Step 6: Validate all Mermaid blocks**

Extract each Mermaid block in memory or through standard input and render it
with Mermaid CLI. Each block must exit successfully and produce non-empty SVG.

Run:

```bash
npx --yes @mermaid-js/mermaid-cli@11.12.0 --input - --output /tmp/laundrotwin-diagram.svg
```

Expected: exit code `0` for each of the five Mermaid blocks.

### Task 2: Add repository navigation and verify the documentation change

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Test: `docs/02_architecture/data-and-activity-diagrams.md`

**Interfaces:**
- Consumes: Architecture document created in Task 1
- Produces: Discoverable architecture source from both repository entry points

- [ ] **Step 1: Add the architecture directory to the README index**

Add `docs/02_architecture/` between requirements and data contracts and describe
it as the target data model and workflow diagrams.

- [ ] **Step 2: Add architecture guidance to AGENTS.md**

Add `docs/02_architecture/` to `Sources of truth`. Require future schema and
workflow changes to update the diagrams when entity relationships or process
decisions change.

- [ ] **Step 3: Run documentation checks**

Run:

```bash
git diff --check
rg -n 'TBD|TODO|gas.leak detected|arbitrary SQL' docs/02_architecture/data-and-activity-diagrams.md
gitleaks git --staged --redact --no-banner --log-level warn .
```

Expected: no whitespace errors, no placeholders, no claim that pressure detects
a gas leak, and no staged secrets.

- [ ] **Step 4: Commit the implementation**

```bash
git add AGENTS.md README.md docs/02_architecture/data-and-activity-diagrams.md
git commit -m "docs: add LaundroTwin data and activity diagrams"
```
