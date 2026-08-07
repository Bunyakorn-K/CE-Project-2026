# CE Project 2026 — LaundroTwin

LaundroTwin is a Smart Laundry Management and Analytics Platform for
commercial laundromat franchise owners, managers, and technicians. The target
product turns existing MQTT and Modbus data into a multi-branch Digital Twin,
business intelligence, safe AI-assisted analysis, and event-driven alerts.

This repository combines the CE Project requirements and data contracts with
the existing LaundryTwin implementation. LaundryTwin is currently a read-only,
mobile-first LINE LIFF reporting application backed by a Hono API and local
SQLite. It is an implementation starting point, not evidence that every
LaundroTwin MVP requirement is complete.

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

| Area | Status |
| --- | --- |
| CE requirements and data-contract documentation | Present |
| LINE LIFF mobile reporting UI | Implemented |
| Local owner, manager, and technician access workflow | Implemented |
| Explicit, labeled demo mode | Implemented |
| Read-only IRIS reporting integration | Client implemented; upstream API required |
| Direct MQTT ingestion and normalized time-series storage | Not implemented in this repository |
| Complete Digital Twin and alert engine from CE requirements | Not implemented |
| Safe AI Executive Assistant | Not implemented |

## Current application architecture

```text
LINE LIFF or local owner account
              |
              v
    LaundryTwin React mobile web
              |
              v
    LaundryTwin Hono API + local SQLite
              |
              | X-LaundryTwin-Read-Key (server only)
              v
    Optional IRIS read-only reporting API
```

The current application never sends machine commands, writes payment data,
or exposes upstream credentials to the browser.

## Repository layout

```text
apps/api/                 Hono API, authentication, RBAC, and reporting client
apps/web/                 React/Vite LINE LIFF application
deploy/                   Container deployment configuration
docs/01_requirements/     CE Project requirements and user stories
docs/02_architecture/     Target data model and Mermaid workflow diagrams
docs/03_data_contracts/   MQTT/Modbus data rules and register evidence
docs/04_traceability/     Requirements Traceability Matrix
docs/integration/         Current IRIS read-only integration contract
```

## Run locally

1. Install Node.js 22+ and pnpm 10+.
2. Copy `.env.example` to `.env`.
3. Set a unique `BETTER_AUTH_SECRET` and a
   `LAUNDRYTWIN_BOOTSTRAP_ADMIN_EMAIL`.
4. Configure `IRIS_READ_BASE_URL` and `IRIS_LAUNDRYTWIN_READ_API_KEY` when the
   corresponding read API is available.
5. Run `pnpm install` and `pnpm dev`.

The web application runs at `http://localhost:5173`; the API runs at
`http://localhost:8787`. Without the IRIS read settings, authenticated users
see an explicit reporting-source-unavailable state rather than fabricated
metrics or machine statuses.

## Demo mode

Set `LAUNDRYTWIN_DEMO_MODE=true` only for local preview or stakeholder demos.
Demo mode is visibly labeled, uses simulated branches, machines, and alerts,
and never acts as an automatic fallback for unavailable production data.

## Access workflow

1. Create or sign in to the local owner account using the bootstrap email.
2. Open `/mange` to review LINE access requests and active grants.
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
API variables are configured. For container deployment, copy
`deploy/.env.production.example` to the deployment host's `.env`, populate the
required values, and run `docker compose up -d --build`. Back up
`data/laundrytwin.sqlite` before replacing the host or persistent volume.

## Verification

```bash
pnpm test
pnpm check
pnpm build
```
