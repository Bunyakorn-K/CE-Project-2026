# IRIS LaundryTwin Read API

## Purpose

This document describes LaundryTwin's optional read-only reporting integration.
It does not claim that IRIS owns or provides the ClickHouse analytics warehouse,
and it does not describe a separate live IRIS machine-usage export.

## Status correction (2026-09-29): the upstream service does not exist

A read of the IRIS repository (`Meepain-group/iris-project` at `813ffa7`)
established that **IRIS serves no LaundryTwin read API at all**. `grep -ri
laundrygo` and `grep -ri laundrytwin` over that repository return zero hits,
and there is no read replica, no export endpoint, and no materialized view for
LaundryTwin reporting. Every endpoint, payload, and `from`/`to` contract
described further down is an **intended historical design recorded in
`docs/superpowers/`, not a running upstream.**

What that means in practice:

- **The only available path from IRIS to LaundryTwin is the ETL reading Postgres
  directly** (`apps/etl`, `PG_CONNECTION_STRING` → `iris_project`). There is no
  alternative integration to fall back to and no service to ask IRIS to expose.
- **The LaundryTwin-side client exists but cannot succeed.**
  `apps/api/src/iris-read-client.ts` reads `IRIS_READ_BASE_URL` and
  `IRIS_LAUNDRYTWIN_READ_API_KEY`, and `apps/api/src/index.ts` derives
  `reportingConfigured` from the base URL alone. With no upstream behind them,
  those two env vars name an integration that is not there: a configured base URL
  is not evidence that reporting works, and the API's explicit
  `REPORTING_SOURCE_FAILED` / `REPORTING_SOURCE_UNAVAILABLE` states are the
  correct observable behaviour.
- **The warehouse is the real reporting surface.** Dashboard and Digital Twin
  development paths read ClickHouse directly (see the root `AGENTS.md`). The
  warehouse data must not be represented as a live IRIS analytics stream.

The sections below are kept as the record of the historical wire contract
(`/v1/laundrygo` with `X-LaundryGo-Read-Key`). The name is preserved only
because the historical plan and the existing env vars refer to it. Anyone
implementing the upstream has to start from IRIS, not from this file.

## Historical wire contract (not implemented upstream)

- URL path: `/v1/laundrygo`
- Header: `X-LaundryGo-Read-Key`

## Configuration (inert without an upstream)

```text
IRIS_READ_BASE_URL=https://<iris-worker>/v1/laundrygo
IRIS_LAUNDRYTWIN_READ_API_KEY=<dedicated integration key>
```

The intended design carried the read key in a server-held header and selected
tenant scope by IRIS Worker secret configuration, never from a LaundryTwin
request. Neither hop exists yet.

## Intended read resources (not served today)

| Endpoint | Intended LaundryTwin use |
| --- | --- |
| `GET /branches` | Filter the branch picker to the local role grant. |
| `GET /dashboard` | Revenue, cycle, machine-count, and utilization aggregates. |
| `GET /branches/:branchId/live` | Current machine state and telemetry coverage. |
| `GET /alerts` | Existing alert evidence; local acknowledgement is overlaid separately. |
| `GET /events` | Technical telemetry history. |

`from` and `to` were to be ISO-8601 timestamps with a maximum 31-day range, and
each successful payload was to include `contractVersion`, `source`, and
`fetchedAt`. None of this is observable today.

## Intended reporting rules (design only)

- `null` plus a coverage object means unavailable data, not a safe zero.
- Only the source's documented `temperature_f` input is converted to Celsius.
- Gas pressure, gas-leak state, and register-map version remain unavailable
  until IRIS supplies verified fields.
- IRIS alert rules version is represented by the `ruleVersion` column and may be
  `null`.
- The intended integration exposed no write route for commands, telemetry
  ingestion, payment mutation, customer data, or database binding. Keeping that
  boundary is a LaundryTwin-side invariant and stays true regardless of the
  upstream.

## Failure handling

LaundryTwin maps missing local integration configuration to
`REPORTING_SOURCE_UNAVAILABLE`. It maps malformed or failed upstream responses
to `REPORTING_SOURCE_FAILED`. A synthetic fallback dashboard or machine status
is permitted only when explicit demo mode is enabled and an explicit demo
session cookie is present. Demo mode is never a production fallback.
