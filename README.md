# CE Project 2026 — LaundroTwin

LaundroTwin is a Smart Laundry Management and Analytics Platform for
commercial laundromat franchise owners, managers, and technicians. The target
product turns existing MQTT and Modbus data into a multi-branch Digital Twin,
business intelligence, safe AI-assisted analysis, and event-driven alerts.

This repository combines the CE Project requirements and data contracts with
the LaundryTwin implementation. LaundryTwin is a read-only, mobile-first
LINE LIFF reporting application backed by a Hono API and local SQLite, with a
server-side analytics warehouse (ClickHouse), MCP assistant, LINE bot, and a
DB-driven AI console. It is an implementation starting point, not evidence
that every LaundroTwin MVP requirement is complete.

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

## Current implementation status

|| Area | Status |
|| --- | --- |
|| CE requirements and data-contract documentation | Present |
|| LINE LIFF mobile reporting UI | Implemented |
|| Local owner, manager, and technician access workflow | Implemented |
|| Explicit, labeled demo mode | Implemented |
|| Read-only IRIS reporting integration | Client implemented; upstream API required |
|| Analytics warehouse (ETL → ClickHouse) | Implemented + deployed (usage, temperature, weather) |
|| Superset BI dashboard | Implemented + deployed (metadata on Postgres) |
|| Airflow freshness DAGs | Implemented + deployed (per-role services on Postgres) |
|| MCP analytics tools (5, allow-listed + RBAC-scoped) | Implemented + verified from LibreChat agents |
|| AI Executive Assistant console (DB-driven gateway) | Implemented (Vercel AI SDK + Bifrost gateway) |
|| LINE bot (agentic, MCP-backed) | Implemented |
|| Direct MQTT ingestion and normalized time-series storage | Not implemented (descoped 2026-09-07 — telemetry flows via IRIS) |
|| Complete Digital Twin and alert engine from CE requirements | Partially implemented (alert ack local to LaundryTwin) |
|| ML off-peak recommendation (baseline) | Implemented (`get_off_peak_windows` MCP tool, percentile heuristic) |
|| ML training data & feature engineering | Documented (`docs/06_ml/ml-training-data-guide.md`) |

## Current application architecture

```text
LINE LIFF / web / LibreChat agent
        |                      |
        v                      v
LaundryTwin React web    LibreChat (chat.laundrytwin.duckdns.org)
        |                      |  MCP tools (5, Bearer token)
        v                      v
LaundryTwin Hono API    └─ MCP server (analytics, allow-listed tools)
        |                      |
        | ClickHouse (warehouse)  <- ETL <- IRIS Postgres (read-only)
        v
Optional IRIS read-only reporting API
```

Deployment topology, DNS, and troubleshooting live in
[`docs/02_architecture/deploy-runbook.md`](docs/02_architecture/deploy-runbook.md).
The AI console, MCP gateway, and demo-login notes are under "Backoffice AI
console" in the ops skill; the LibreChat MCP/agent wiring is verified and
documented in
[`docs/04_traceability/ops-verification-2026-09-14-librechat-tools.md`](docs/04_traceability/ops-verification-2026-09-14-librechat-tools.md).

The current application never sends machine commands, writes payment data,
or exposes upstream credentials to the browser.

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

1. Install Node.js 24 (see `.nvmrc`; better-sqlite3 is compiled for ABI 137)
   and pnpm 10+.
2. Copy `.env.example` to `.env`.
3. Set a unique `BETTER_AUTH_SECRET` and a
   `LAUNDRYTWIN_BOOTSTRAP_ADMIN_EMAIL`.
4. Configure `IRIS_READ_BASE_URL` and `IRIS_LAUNDRYTWIN_READ_API_KEY` when the
   corresponding read API is available.
5. Run `pnpm install` and `pnpm dev`.

The web application runs at `http://localhost:5173`; the API runs at
`http://localhost:8787` (and serves the MCP endpoint at `/mcp`). Without the
IRIS read settings, authenticated users see an explicit
reporting-source-unavailable state rather than fabricated metrics or machine
statuses.

## Demo mode

Set `LAUNDRYTWIN_DEMO_MODE=true` only for local preview or stakeholder demos.
Demo mode is visibly labeled, uses simulated branches, machines, and alerts,
and never acts as an automatic fallback for unavailable production data. On
the deployed stack, the backoffice login uses an explicit "Sign in as Demo
Owner" button (`POST /api/demo/session`), never an automatic fallback.

## Access workflow

1. Create or sign in to the local owner account using the bootstrap email
   (or the demo owner session on the deployed stack).
2. Open `/manage` to review LINE access requests and active grants.
3. A LINE user opens the LIFF application and the API verifies their ID token.
4. The owner approves the request as `owner`, `manager`, or `technician`.
5. The user receives a short-lived, HttpOnly LaundryTwin session cookie.

| Role | Branch scope | Revenue | Access administration |
| --- | --- | --- | --- |
| Owner | All branches in the configured tenant | Yes | Yes |
| Manager | One assigned branch per grant | Yes | No |
| Technician | One assigned branch per grant | No | No |

Alert acknowledgement is local to LaundryTwin and audit-logged. It does not
acknowledge an upstream alert.

## LINE and production configuration

Set `VITE_LIFF_ID` for the browser and `LINE_LOGIN_CHANNEL_ID` for server-side
ID-token verification. Channel secrets, access tokens, upstream read keys, and
the Better Auth secret must remain server-side.

`POST /webhooks/line` is optional and remains disabled until the LINE Messaging
API variables are configured. For container deployment, each app builds from
its own `apps/<pkg>/Dockerfile` (turbo prune + minimal runtime, ~29–69 MB
compressed) and images are pushed to the internal registry
(`registry.laundrytwin.duckdns.org`; VM pulls via `10.10.0.117:5000`), then
`docker compose pull <svc> && up -d <svc>` on the VM. Back up
`data/laundrytwin.sqlite` before replacing the host or persistent volume.

## Verification

```bash
pnpm test
pnpm check
pnpm build
```
