# IRIS LaundryTwin Read API

## Purpose

## Verified implementation status (2026-08-14)

This document describes the optional reporting integration that already exists.
It does not prove that the separate machine-usage analytics export exists.

Verified today:

- The reporting resources below may be consumed by the LaundryTwin API when the
  IRIS base URL and dedicated key are configured.
- `GET /api/analytics/machine-usage` in LaundryTwin authenticates its Airflow
  caller but currently returns an explicit empty placeholder with the note
  `IRIS machine_usage endpoint not implemented; requires IRIS API support`.
- IRIS `origin/main` does not currently expose the tenant-bound
  `/v1/laundrytwin/usage` export described in the analytics design document.
- Consequently, ClickHouse and Superset data must not be represented as live
  IRIS analytics. The single usage row present on 2026-08-14 is synthetic
  verification data extracted on 2026-08-09.

Team members must not enable the five-minute Airflow schedule, run a backfill,
or remove the explicit placeholder note until a direct authenticated export
request returns real rows and a cursor. Do not reuse browser credentials,
production database credentials, the general IoT key, or backoffice server
functions as a substitute export path.

The target export contract and activation gate are documented in:

- `docs/superpowers/specs/2026-08-08-iris-laundrytwin-analytics-export-design.md`
- `docs/superpowers/specs/2026-08-08-airflow-dag-iris-usage.md`

LaundryTwin consumes a dedicated, tenant-bound, read-only IRIS API. It is not a
 general reporting integration. The LaundryTwin Hono server is the only consumer;
 browser code must not call IRIS directly.

## Configuration

```text
IRIS_READ_BASE_URL=https://<iris-worker>/v1/laundrygo
IRIS_LAUNDRYTWIN_READ_API_KEY=<dedicated integration key>
```

Every request includes the server-held `X-LaundryGo-Read-Key` header. Tenant
scope is selected by the IRIS Worker secret configuration and cannot be changed
by a LaundryTwin request.

The `X-LaundryGo-Read-Key` header name and `/v1/laundrygo` URL path are the
IRIS-side wire contract and remain unchanged by the LaundryTwin rename.

## Read resources

| Endpoint | LaundryTwin use |
| --- | --- |
| `GET /branches` | Filter the branch picker to the local role grant. |
| `GET /dashboard` | Revenue, cycle, machine-count, and utilization aggregates. |
| `GET /branches/:branchId/live` | Current machine state and telemetry coverage. |
| `GET /alerts` | Existing alert evidence; local acknowledgement is overlaid separately. |
| `GET /events` | Technical telemetry history. |

`from` and `to` are ISO-8601 timestamps. IRIS accepts a maximum 31-day range.
Each successful payload includes `contractVersion`, `source`, and `fetchedAt`.

## Reporting rules

- `null` plus a coverage object means unavailable data, not a safe zero.
- Only the source's documented `temperature_f` input is converted to Celsius.
- Gas pressure, gas-leak state, and register-map version remain unavailable until IRIS supplies fields.
- IRIS alert rules version is represented by the `ruleVersion` column and may be `null`.
- The integration exposes no write route for commands, telemetry ingestion, payment mutation, customer data, or database binding.

## Failure handling

LaundryTwin maps missing local integration configuration to the explicit
`REPORTING_SOURCE_UNAVAILABLE` response. It maps malformed or failed upstream
responses to `REPORTING_SOURCE_FAILED`. A synthetic fallback dashboard machine
status is permitted only in explicitly enabled demo mode.
