# LaundryTwin Repository Guide

## Purpose and authority

This repository is the CE Project 2026 workspace for the Smart Laundry
Management and Analytics Platform, also called LaundryTwin. It contains both
the project requirements and the current LaundryTwin application.

The current application is a LINE LIFF reporting surface that is read-only with
respect to IRIS, machine commands, and payment data. Local access grants,
alert acknowledgements, sessions, and AI settings are writable. It is a starting
implementation and does not yet satisfy every target requirement. Never
describe a requirement as implemented unless code and verification evidence in
this repository support that claim.

Direct user instructions take precedence over this guide.

## Repository identity

- Canonical repository: `https://github.com/Bunyakorn-K/CE-Project-2026`
- Default branch: `main`

This directory is now the application repository, not a temporary planning
workspace. Keep project documentation and implementation changes here. IRIS is
an optional read-only integration for the current LaundryTwin implementation; do
not redirect CE Project work to a Meepain-group repository unless the user
explicitly requests a cross-repository change.

## Product goal

Existing laundromats expose operational data through local Modbus, ESP, MQTT,
and Raspberry Pi systems. LaundryTwin aims to turn that existing data into a
multi-branch Digital Twin, franchise-level business intelligence, safe
AI-assisted analysis, and event-driven notifications.

Target users are commercial laundromat franchise owners, branch managers, and
technicians.

## Sources of truth

Read the relevant project documents before changing code:

- `docs/01_requirements/`: requirements, user stories, functions, priorities,
  and acceptance criteria.
- `docs/02_architecture/`: target data relationships and activity flows. Update
  the diagrams when entity ownership, process decisions, or failure paths change.
- `docs/03_data_contracts/`: telemetry fields, register maps, units, validation,
  and unresolved semantics. Read this before changing schemas, MQTT parsing,
  KPIs, alerts, or API contracts.
- `docs/04_traceability/RTM_matrix.md`: requirement-to-function traceability.
- `docs/integration/iris-laundrytwin-read-api.md`: current optional IRIS read-only
  integration. It does not override the CE requirements or data contracts.
- `docs/06_ml/ml-training-data-guide.md`: ML feature engineering schema,
  training data pipeline, and model training plan (Phase 2).
- `docs/02_architecture/deploy-runbook.md`: deployment topology, service
  configuration, and operational verification.
- `apps/web/PRODUCT.md`: web product users, workflows, constraints, and
  Thai-first product principles.

Historical plans under `docs/superpowers/` are implementation evidence, not
current product authority.

## Phase 2 status

| Item | Status | Evidence |
|------|--------|----------|
| Weather context (F-12 label; see RTM ambiguity note) | Done (2026-09-10) | `apps/etl/src/weather.ts`, `fact_weather_sample` |
| ML off-peak baseline (#35) | Done (2026-09-14) | `get_off_peak_windows` MCP tool |
| ML training data guide | Added (2026-09-22) | `docs/06_ml/ml-training-data-guide.md` |
| Superset bootstrap (#42) | Done (2026-09-13) | `deploy/analytics/bootstrap-superset.sh` |
| Airflow Postgres (#42) | Done (2026-09-13) | `docs/04_traceability/ops-verification-2026-09-13-airflow-superset.md` |

Data volume is ~4.8k usage rows (~1 week). Sufficient for baseline only;
≥ 3 months needed for Prophet/SARIMA/GBM candidates. See
`docs/06_ml/ml-training-data-guide.md` §5 for data requirements.

## Current production caveats

As of 2026-09-25, direct ClickHouse Dashboard and Digital Twin routes have
local automated evidence for server-side branch scope, zero-grant denial,
strict calendar date validation, bind-parameter queries, nullable revenue
redaction, active-inventory retention, usage-derived freshness, and unknown
state preservation. This is code/test evidence, not production E2E. The LINE
authentication flow is not yet verified end to end. Better Auth requires
`BETTER_AUTH_SECRET` outside test, disables public signup, and enables bounded
rate limits. Development access requires both `NODE_ENV=development` and
`LAUNDRYTWIN_DEV_BYPASS=true`; it uses an in-memory `Development Owner`, reads
configured real analytics sources, and is not a production security design.
Explicit demo mode requires a demo session cookie and remains preview-only.
MCP requires `MCP_ACCESS_TOKEN`; `MCP_ALLOW_REVENUE` is explicit false by
default. `fact_machine_event` is currently empty, so Digital Twin state is
derived from usage data rather than live telemetry.

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
apps/api/   Hono API, Better Auth, local SQLite, RBAC, direct ClickHouse reports, MCP, LINE bot, AI console
apps/web/   React/Vite mobile web and LINE LIFF interface
apps/etl/   Batch ETL: IRIS Postgres -> ClickHouse (usage/temperature/weather) + TMD weather collector
deploy/     Docker and Nginx deployment files (analytics compose: ClickHouse, Superset, Airflow, Postgres, Redis)
```

The current LaundryTwin paths are:

```text
LINE LIFF/browser -> React web -> Hono API + SQLite -> optional IRIS read API
                                      |
                                      +-> direct ClickHouse dashboard and Digital Twin
                                      |
                                      v
                              ClickHouse analytics warehouse
                              (fact_machine_usage, fact_weather_sample,
                               fact_temperature_sample, dim_branch_location)
                                      |
                                      v
                              allow-listed MCP analytics tools
```

The direct ClickHouse report endpoints have local code/test evidence for
server-side branch scope, zero-grant denial, strict calendar ranges, bound
ClickHouse parameters, nullable revenue redaction, active-inventory retention,
usage-derived freshness, and unknown-state preservation. Treat that as local
verification only; production E2E, staging behavior, and LINE/browser E2E are
still pending.

The weather collector (`laundrytwin-weather-1` on VM 117) runs
hourly (`sleep 3600`). It fetches TMD NWP forecasts and inserts
into `fact_weather_sample` tagged by `tenant_id/branch_id`.
Location targets come from `dim_branch_location` JOIN `dim_branch active=1`.
Location schema includes province, sub_district, district (currently NULL).

The ML baseline (`get_off_peak_windows`) uses a percentile heuristic
over `fact_machine_usage`. The complete feature engineering guide for
training models is in `docs/06_ml/ml-training-data-guide.md`.

The browser must never receive upstream service credentials. Development mode
uses a local owner bypass for browser access only, requires both
`NODE_ENV=development` and `LAUNDRYTWIN_DEV_BYPASS=true`, and reads configured
real analytics sources; it must never be enabled in production. Demo mode
requires an explicit demo session cookie, remains visibly labeled for
non-development previews, and must never be an automatic fallback for
unavailable real data. MCP requires a service token, and revenue access is
explicitly disabled unless `MCP_ALLOW_REVENUE=true`. Machine commands, payment
writes, and telemetry ingestion are not part of the current implementation.

## Web design direction

Use a restrained commercial-operations visual system:

- Use LaundryTwin as the canonical product name.
- Use a calm navy/teal palette, white surfaces, clear borders, and restrained
  shadows. Reserve color for status and action, not decoration.
- Use a readable Thai-capable font stack, with monospace only for machine IDs,
  timestamps, and telemetry values.
- Prefer inline SVG or existing component icons over emoji for navigation and
  KPI indicators.
- Keep data source, demo mode, freshness, unknown, stale, and unavailable states
  visible in the interface.
- Keep Dashboard and Digital Twin visually related while preserving their
  distinct meanings and existing API behavior.
- Treat mobile LINE LIFF and desktop operations views as one responsive system;
  do not constrain desktop content to a phone-width shell.

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

1. Fetch `origin` and verify the current `main` before starting substantive
   work. Preserve unrelated user changes in the working tree.
2. Identify the requirement, user story, function, and data contract affected.
3. State assumptions and unresolved hardware or data semantics.
4. Make the smallest change that satisfies the acceptance criteria.
5. Add or update focused tests, including tenant isolation and failure cases.
6. Run the narrow test first, then the repository verification commands.
7. Update the RTM or source document when approved scope changes.
8. Commit only reviewed files. Pushing code does not authorize deployment,
   production migration, or live machine actions.

Do not create a speculative parallel `src/` tree. Extend `apps/api` and
`apps/web` unless an approved architecture change establishes a new package.

## Verification

Use Node.js 24.13.0 and pnpm 10.33.4.

Local automated evidence on 2026-09-25: **181 tests green** — API 142, web 2,
ETL 37. `pnpm --filter @laundrytwin/api check`, web check/test/build, and ETL
test pass. This does not establish staging, LINE, browser, or production E2E.

```bash
pnpm test
pnpm check
pnpm build
```

### Secret scanning (git hooks)

`core.hooksPath` is set to `.githooks/` (enable on a fresh clone with
`git config core.hooksPath .githooks`). pre-commit runs
`gitleaks protect --staged --redact`; pre-push scans the pushed history range.
Both require the `gitleaks` binary (brew install gitleaks). Documented false
positives go in `.gitleaks.toml` with a reason; bypassing with `--no-verify`
is discouraged and must never be used to commit a real secret.

Review `git diff --check`, ignored runtime data, and staged secret scanning
before committing. Deployment, production migration, or live machine actions
require an explicit user request, a rollback target, and a post-change smoke
test.
