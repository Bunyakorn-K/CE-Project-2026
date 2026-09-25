# IRIS LaundryTwin Read API

## Purpose

This document describes LaundryTwin's optional read-only reporting integration.
It does not claim that IRIS owns or provides the ClickHouse analytics warehouse,
and it does not describe a separate live IRIS machine-usage export.

## Current integration status (2026-09-25)

LaundryTwin's Hono API is the only consumer of this integration. It uses the
server-held base URL and dedicated read key to request the reporting resources
below. Browser code never calls IRIS directly, and the integration has no
command, payment, telemetry-ingestion, customer-data, or database-binding
write route.

The current Dashboard and Digital Twin development path reads usage-derived
ClickHouse data directly. Non-development IRIS-backed report routes remain
optional and return explicit unavailable/failed states when the integration is
not configured or cannot provide a usable response. The current warehouse data
must not be represented as a live IRIS analytics stream.

The historical external wire contract remains unchanged:

- URL path: `/v1/laundrygo`
- Header: `X-LaundryGo-Read-Key`

These names are preserved because they are an IRIS-side external contract; the
LaundryTwin product rename does not rename them.

## Configuration

```text
IRIS_READ_BASE_URL=https://<iris-worker>/v1/laundrygo
IRIS_LAUNDRYTWIN_READ_API_KEY=<dedicated integration key>
```

Every request includes the server-held `X-LaundryGo-Read-Key` header. Tenant
scope is selected by IRIS Worker secret configuration and cannot be changed by a
LaundryTwin request.

## Read resources

| Endpoint | LaundryTwin use |
| --- | --- |
| `GET /branches` | Filter the branch picker to the local role grant. |
| `GET /dashboard` | Revenue, cycle, machine-count, and utilization aggregates. |
| `GET /branches/:branchId/live` | Current machine state and telemetry coverage. |
| `GET /alerts` | Existing alert evidence; local acknowledgement is overlaid separately. |
| `GET /events` | Technical telemetry history. |

`from` and `to` are ISO-8601 timestamps for this upstream contract. IRIS accepts
a maximum 31-day range. Each successful payload includes `contractVersion`,
`source`, and `fetchedAt`; the API validates the response before exposing it to
the application.

## Reporting rules

- `null` plus a coverage object means unavailable data, not a safe zero.
- Only the source's documented `temperature_f` input is converted to Celsius.
- Gas pressure, gas-leak state, and register-map version remain unavailable
  until IRIS supplies verified fields.
- IRIS alert rules version is represented by the `ruleVersion` column and may
  be `null`.
- The integration exposes no write route for commands, telemetry ingestion,
  payment mutation, customer data, or database binding.

## Failure handling

LaundryTwin maps missing local integration configuration to
`REPORTING_SOURCE_UNAVAILABLE`. It maps malformed or failed upstream responses
to `REPORTING_SOURCE_FAILED`. A synthetic fallback dashboard or machine status
is permitted only when explicit demo mode is enabled and an explicit demo
session cookie is present. Demo mode is never a production fallback.
