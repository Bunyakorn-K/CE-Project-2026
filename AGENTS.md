# LaundroTwin Repository Guide

## Purpose and authority

This repository is the CE Project 2026 workspace for the Smart Laundry
Management and Analytics Platform, also called LaundroTwin. It contains both
the project requirements and the current LaundryGo application.

The current application is a read-only LINE LIFF reporting surface. It is a
starting implementation and does not yet satisfy every target requirement.
Never describe a requirement as implemented unless code and verification
evidence in this repository support that claim.

Direct user instructions take precedence over this guide.

## Product goal

Existing laundromats expose operational data through local Modbus, ESP, MQTT,
and Raspberry Pi systems. LaundroTwin aims to turn that existing data into a
multi-branch Digital Twin, franchise-level business intelligence, safe
AI-assisted analysis, and event-driven notifications.

Target users are commercial laundromat franchise owners, branch managers, and
technicians.

## Sources of truth

Read the relevant project documents before changing code:

- `docs/01_requirements/`: requirements, user stories, functions, priorities,
  and acceptance criteria.
- `docs/03_data_contracts/`: telemetry fields, register maps, units, validation,
  and unresolved semantics. Read this before changing schemas, MQTT parsing,
  KPIs, alerts, or API contracts.
- `docs/04_traceability/RTM_matrix.md`: requirement-to-function traceability.
- `docs/integration/iris-laundrygo-read-api.md`: current optional IRIS read-only
  integration. It does not override the CE requirements or data contracts.

Historical plans under `docs/superpowers/` are implementation evidence, not
current product authority.

## Strict physical and safety boundaries

- Do not propose hardware modifications, new sensors, or rewiring unless the
  user explicitly changes the project scope.
- Derive machine behavior only from verified existing registers and MQTT data.
  Do not invent register meanings or silently infer unknown states.
- Pressure trends may support a low-gas estimate when evaluated with machine
  state and temperature. Do not claim that pressure alone detects a gas leak.
- Dedicated life-safety detection and local alarms are outside the current
  software-only scope. Never represent a cloud estimate as a safety system.
- Treat `paid` semantics, coin-box reset behavior, unknown registers, units,
  and model-specific mappings as unresolved until verified by evidence.

## Target MVP pillars

1. Multi-branch tenancy with server-enforced branch isolation and RBAC.
2. A context-aware Digital Twin showing verified machine state, remaining
   time, and temperature.
3. Traceable revenue, cycle, utilization, and alert analytics.
4. An Executive Assistant that calls allow-listed analytics functions and
   never executes arbitrary model-generated SQL.
5. Idempotent LINE Messaging API alerts with cooldowns and audit history.

## Current implementation

```text
apps/api/   Hono API, Better Auth, local SQLite, RBAC, demo/read clients
apps/web/   React/Vite mobile web and LINE LIFF interface
deploy/     Docker and Nginx deployment files
```

The current LaundryGo path is:

```text
LINE LIFF/browser -> React web -> Hono API + SQLite -> optional IRIS read API
```

The browser must never receive upstream service credentials. Demo mode must
remain explicit and visibly labeled; it must never be an automatic fallback
for unavailable real data. Machine commands, payment writes, and telemetry
ingestion are not part of the current implementation.

## Engineering invariants

- Every tenant-scoped query is authorized on the server and constrained by
  branch assignment.
- Keep money as integer satang until presentation.
- Keep event time and receive time separate when telemetry is introduced.
- Version register maps and alert rules; preserve the evidence that triggered
  each alert.
- Alerts must be idempotent and must not spam recipients.
- Use parameterized, allow-listed analytics functions for AI features.
- Preserve missing, stale, offline, and unknown states; do not fabricate data.
- Never commit credentials, provider tokens, production databases, customer
  data, live captures, or local `.env` files.

## Change workflow

1. Identify the requirement, user story, function, and data contract affected.
2. State assumptions and unresolved hardware or data semantics.
3. Make the smallest change that satisfies the acceptance criteria.
4. Add or update focused tests, including tenant isolation and failure cases.
5. Run the narrow test first, then the repository verification commands.
6. Update the RTM or source document when approved scope changes.

Do not create a speculative parallel `src/` tree. Extend `apps/api` and
`apps/web` unless an approved architecture change establishes a new package.

## Verification

Use Node.js 22+ and pnpm 10+.

```bash
pnpm test
pnpm check
pnpm build
```

Review `git diff --check`, ignored runtime data, and staged secret scanning
before committing. Deployment, production migration, or live machine actions
require an explicit user request, a rollback target, and a post-change smoke
test.
