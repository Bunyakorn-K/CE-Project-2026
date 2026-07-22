# IRIS LaundryGo Read API

## Purpose

LaundryGo consumes a dedicated, tenant-bound, read-only IRIS API. This is not a
general reporting integration. The LaundryGo Hono server is the only consumer;
browser code must never call it directly.

## Configuration

```text
IRIS_READ_BASE_URL=https://<iris-worker>/v1/laundrygo
IRIS_LAUNDRYGO_READ_API_KEY=<dedicated integration key>
```

Every request includes the server-held `X-LaundryGo-Read-Key` header. Tenant
scope is selected by the IRIS Worker secret configuration and cannot be changed
by a LaundryGo request.

## Read resources

| Endpoint | LaundryGo use |
| --- | --- |
| `GET /branches` | Filter the branch picker to the local role grant. |
| `GET /dashboard` | Revenue, cycle, machine-count, and utilization aggregates. |
| `GET /branches/:branchId/live` | Current machine state and telemetry coverage. |
| `GET /alerts` | Existing alert evidence; local acknowledgement is overlaid separately. |
| `GET /events` | Technical telemetry history. |

`from` and `to` are ISO-8601 timestamps. IRIS accepts a maximum 31-day range.
Each successful payload includes `contractVersion`, `source`, and `fetchedAt`.

## Reporting rules

- `null` plus a coverage object means unavailable data, never a safe zero.
- Only the source's documented `temperature_f` input is converted to Celsius.
- Gas pressure, gas-leak state, and register-map version remain unavailable
  until IRIS supplies those fields.
- IRIS alert rules have no version column, so `ruleVersion` can be `null`.
- The integration has no write route and exposes no commands, telemetry
  ingestion, payment mutation, customer data, or database binding.

## Failure handling

LaundryGo maps a missing local integration configuration to an explicit
`REPORTING_SOURCE_UNAVAILABLE` response. It maps malformed or failed upstream
responses to `REPORTING_SOURCE_FAILED`. No fallback dashboard or synthetic
machine status is permitted.
