# CE Project 2026 — LaundryTwin

LaundryTwin is a Smart Laundry Management and Analytics Platform for
commercial laundromat franchise owners, managers, and technicians. The target
product turns existing MQTT and Modbus data into a multi-branch Digital Twin,
business intelligence, safe AI-assisted analysis, and event-driven alerts.

This repository combines the CE Project requirements and data contracts with
the LaundryTwin implementation. LaundryTwin is a mobile-first LINE LIFF
reporting application backed by a Hono API and local SQLite, with a server-side
analytics warehouse (ClickHouse), MCP assistant, LINE bot, and a DB-driven AI
console. It is read-only with respect to IRIS, machine commands, and payment
data; local access grants, alert acknowledgements, sessions, and AI settings are
writable. It is an implementation starting point, not evidence that every
LaundryTwin MVP requirement is complete.

## Sources of truth

Read these documents before changing behavior or data models:

- [`docs/01_requirements/`](docs/01_requirements/) defines requirements,
  functions, user stories, priorities, and acceptance criteria.
- [`docs/02_architecture/`](docs/02_architecture/) defines the target-MVP data
  model and the main ingestion, access, alert, and AI workflows.
- [`docs/03_data_contracts/`](docs/03_data_contracts/) defines telemetry fields,
  Modbus mappings, units, validation rules, and unresolved hardware semantics.
- [`docs/04_traceability/RTM_matrix.md`](docs/04_traceability/RTM_matrix.md)
  maps requirements to system functions and user stories.
- [`docs/integration/iris-laundrytwin-read-api.md`](docs/integration/iris-laundrytwin-read-api.md)
  describes the current optional IRIS read-only integration.
- [`docs/06_ml/ml-training-data-guide.md`](docs/06_ml/ml-training-data-guide.md)
  defines the ML feature schema, training pipeline, and modeling plan.
- [`apps/web/PRODUCT.md`](apps/web/PRODUCT.md) records the web product context,
  users, workflows, constraints, and Thai-first principles.

## Current implementation status

|| Area | Status |
|| --- | --- |
|| CE requirements and data-contract documentation | Present |
|| LINE LIFF mobile reporting UI | Implemented; end-to-end LINE authentication still unverified |
|| Local owner, manager, and technician access workflow | Implemented in current routes; server-side branch scope, zero-grant denial, date validation, and revenue redaction have local code/test evidence; production E2E pending |
|| Explicit, labeled demo mode | Implemented; requires an explicit demo session cookie and is preview-only, not a production fallback |
|| Read-only IRIS reporting integration | Client implemented; upstream API required |
|| Direct ClickHouse dashboard and Digital Twin | Implemented; server-side branch scope, strict dates, bind parameters, nullable revenue redaction, active inventory, usage-derived freshness, and unknown-state preservation have local code/test evidence; production E2E pending |
|| Analytics warehouse (ETL → ClickHouse) | Implemented + deployed (usage, temperature, weather) |
|| Superset BI dashboard | Implemented + deployed (metadata on Postgres) |
|| Airflow freshness DAGs | Implemented + deployed (per-role services on Postgres) |
|| MCP analytics tools (6, allow-listed) | Implemented; `MCP_ACCESS_TOKEN` is required, `MCP_ALLOW_REVENUE` is explicit false by default, and LINE scope is server-derived and signed |
|| AI Executive Assistant console (DB-driven gateway) | Implemented (Vercel AI SDK + Bifrost gateway) |
|| LINE bot (agentic, MCP-backed) | Implemented |
|| Direct MQTT ingestion | Not implemented (descoped 2026-09-07 — telemetry flows via IRIS) |
|| Batch normalized usage/temperature storage | Implemented through IRIS-to-ClickHouse ETL |
|| Complete Digital Twin and alert engine from CE requirements | Partially implemented (alert acknowledgement is local to LaundryTwin) |
|| ML off-peak recommendation (baseline) | Implemented (`get_off_peak_windows` MCP tool, percentile heuristic) |
|| ML training data & feature engineering | Documented (`docs/06_ml/ml-training-data-guide.md`) |

## Current application architecture

```text
LINE LIFF / web / LibreChat agent
        |                      |
        v                      v
LaundryTwin React web    LibreChat (chat.laundrytwin.duckdns.org)
        |                      |  /mcp (6 allow-listed tools, service bearer token)
        v                      v
LaundryTwin Hono API    └─ MCP server (analytics, allow-listed tools)
        |                      |
        +-> direct ClickHouse dashboard and Digital Twin
        |
        +-> optional IRIS read-only reporting API
        |
        v
ClickHouse (warehouse) <- ETL <- IRIS Postgres (read-only)
```

Deployment topology, DNS, and troubleshooting live in
[`docs/02_architecture/deploy-runbook.md`](docs/02_architecture/deploy-runbook.md).
Service-specific setup lives in [`deploy/etl/README.md`](deploy/etl/README.md)
and [`deploy/tofu/README.md`](deploy/tofu/README.md). LibreChat MCP/agent wiring
is documented in
[`docs/04_traceability/ops-verification-2026-09-14-librechat-tools.md`](docs/04_traceability/ops-verification-2026-09-14-librechat-tools.md).

The active web router currently includes branch/date filters, nullable revenue,
source/freshness/availability states, analytics series and tables, alert
evidence and acknowledgement, owner-only access grants/admin tools, AI settings
and history, owner-only Playground, legal navigation, and LIFF error retry.
Screenshot/browser QA is still pending.

The current application never sends machine commands, writes payment data,
or exposes upstream credentials to the browser. Current MCP analytics exposes
six allow-listed tools; `accessScope` is not a model argument. The LINE bot
signs server-derived per-session scope. Local audit entries cover grants,
alerts, and settings, but a complete append-only AI prompt/tool-call audit
table does not exist yet.

## Web design direction

The web UI should feel like commercial laundry operations software rather than a
prototype. Use LaundryTwin as the canonical name, a calm navy/teal palette,
white surfaces, clear borders, restrained shadows, and a Thai-capable font stack.
Use status colors for state and action, pair every status with text, and keep
source, demo mode, freshness, unknown, stale, and unavailable states visible.
Avoid emoji as primary navigation or KPI iconography. Dashboard and Digital
Twin may share visual primitives but must retain distinct operational meaning.

## Repository layout

```text
apps/api/                 Hono API, auth/RBAC, reporting, analytics MCP server, LINE bot, AI console
apps/web/                 React/Vite LINE LIFF application (includes /playground route)
apps/etl/                 Batch ETL: IRIS Postgres -> ClickHouse (usage/temperature/weather)
apps/playground/          (merged into web — see apps/web /playground)
deploy/                   Container deployment config (per-app Dockerfiles, compose, tofu, nginx)
deploy/analytics/         Analytics compose (clickhouse, superset, airflow, postgres, redis, mcp)
deploy/analytics/seed/    Superset dashboard seed (committed, placeholder password)
docs/01_requirements/     CE Project requirements and user stories
docs/02_architecture/     Target data model and Mermaid workflow diagrams
docs/03_data_contracts/   MQTT/Modbus data rules and register evidence
docs/04_traceability/     Requirements Traceability Matrix + ops verification records
docs/06_ml/               ML algorithm comparison + ML training data & feature engineering guide
docs/integration/         Current IRIS read-only integration contract
```

## ML / Analytics

See `docs/06_ml/ml-training-data-guide.md` for the complete feature
engineering schema, training data pipeline, and model training plan.
The warehouse (`laundrytwin_analytics` on VM 117) holds `fact_machine_usage`,
`fact_weather_sample`, `fact_temperature_sample`, `dim_branch`, and
`dim_branch_location`. Current data volume (~4.8k rows, ~1 week) is
far too little for robust time-series modeling — the honest baseline
is the percentile heuristic (`get_off_peak_windows` MCP tool).

## Run locally

1. Install Node.js 24.13.0 (see `.nvmrc`; better-sqlite3 is compiled for ABI 137)
   and pnpm 10.33.4.
2. Copy `.env.example` to `.env`.
3. Set a unique `BETTER_AUTH_SECRET` and a
   `LAUNDRYTWIN_BOOTSTRAP_ADMIN_EMAIL`. Better Auth requires the secret outside
   tests, disables public signup, and enables bounded rate limits.
4. Configure `IRIS_READ_BASE_URL` and `IRIS_LAUNDRYTWIN_READ_API_KEY` when the
   corresponding read API is available.
5. Configure ClickHouse values for direct Dashboard, Digital Twin, and MCP
   analytics. Configure the ETL package separately with `TMD_API_KEY` for
   weather collection.
6. Run `pnpm install` and `pnpm dev`. The development bypass requires both
   `NODE_ENV=development` and `LAUNDRYTWIN_DEV_BYPASS=true`; it creates an
   in-memory `Development Owner` and reads configured real analytics sources.
7. Keep `LAUNDRYTWIN_DEMO_MODE=false` for normal development. It is ignored in
   development; a non-development preview must first obtain an explicit demo
   session cookie.

The web application runs at `http://localhost:5173`; the API runs at
`http://localhost:8787` (and serves the MCP endpoint at `/mcp`). IRIS-backed
routes show an explicit reporting-source-unavailable state when IRIS is not
configured. Dashboard and Digital Twin use direct ClickHouse reports when
ClickHouse is available.

## Demo mode

Set `LAUNDRYTWIN_DEMO_MODE=true` only for a non-development preview or
stakeholder demo. The preview still requires an explicit
`laundrytwin_demo_session` cookie created by `/api/demo/session`; it is visibly
labeled and never acts as an automatic fallback for unavailable real data.
When `NODE_ENV=development`, demo mode is ignored and the bypass requires
`LAUNDRYTWIN_DEV_BYPASS=true`; it reads configured real analytics sources. Demo
mode is not a production design.

## Access workflow

1. In local development, open the app directly; the API creates an in-memory
   `Development Owner` without a persisted development grant. Outside
   development, create or sign in to an approved local owner account.
2. Open `/admin` for owner-only access requests/grants and AI settings/history.
   The owner-only Playground and legal navigation are also part of the active
   web router.
3. A LINE user opens the LIFF application and the API verifies its ID token.
4. The owner approves the request as `owner`, `manager`, or `technician`.
5. The user receives a short-lived, HttpOnly LaundryTwin session cookie. The
   LINE bot derives MCP branch/revenue scope from server-resolved grants.

| Role | Branch scope | Revenue | Access administration |
| --- | --- | --- | --- |
| Owner | All branches in the configured tenant | Yes | Yes |
| Manager | One assigned branch per grant | Yes | No |
| Technician | One assigned branch per grant | No | No |

These controls have local code/test evidence on direct Dashboard/Twin and
analytics routes. Production E2E, staging, LINE, and browser verification are
still pending.

Alert acknowledgement is local to LaundryTwin and audit-logged. It does not
acknowledge an upstream alert.

## LINE and production configuration

Set `VITE_LIFF_ID` for the browser and `LINE_LOGIN_CHANNEL_IDS` for server-side
ID-token verification. The singular `LINE_LOGIN_CHANNEL_ID` remains supported
for legacy configuration. Channel secrets, access tokens, upstream read keys,
and the Better Auth secret must remain server-side.

`POST /webhooks/line` is optional and remains disabled until the LINE Messaging
API variables are configured. For container deployment, each app builds from
its own `apps/<pkg>/Dockerfile` (turbo prune + minimal runtime, ~29–69 MB
compressed) and images are pushed to the internal registry
(`registry.laundrytwin.duckdns.org`; VM pulls via `10.10.0.117:5000`), then
`docker compose pull <svc> && docker compose up -d <svc>` on the VM. Before
replacing a host or persistent volume, back up the app SQLite database, the ETL
watermark, and the ClickHouse/Postgres analytics volumes.

## Verification

Local automated evidence on 2026-09-25: **181 tests green** — API 142, web 2,
ETL 37. `pnpm --filter @laundrytwin/api check`, web check/test/build, and ETL
test pass. This does not establish staging, LINE, browser, or production E2E.

```bash
pnpm test
pnpm check
pnpm build
```
