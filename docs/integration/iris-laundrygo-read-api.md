# IRIS LaundryTwin Read API

## Purpose

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
