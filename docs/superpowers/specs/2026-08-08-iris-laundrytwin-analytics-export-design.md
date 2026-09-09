# IRIS LaundryTwin Analytics Export API Design

## Overview

## Implementation gate (verified 2026-08-14)

This file is a target contract, not evidence of a deployed IRIS endpoint.
IRIS `origin/main` currently has no tenant-bound LaundryTwin machine-usage
export. LaundryTwin therefore returns an authenticated, explicit empty
placeholder from `GET /api/analytics/machine-usage`; it does not call a real
usage export yet.

The export is considered implemented only when all of the following are true:

1. IRIS exposes a read-only route protected by a server-held credential bound
   to one tenant; the caller cannot select another tenant.
2. Pagination orders mutable usage rows lexicographically by `(updated_at, id)`
   and returns a cursor with the same two values.
3. A direct authenticated request returns real rows, preserves integer satang,
   source timestamps, source IDs, status, and unresolved attribution values,
   and advances the cursor across pages.
4. LaundryTwin validates that response and removes the explicit placeholder
   only after the upstream integration is verified.
5. Airflow completes one manual extract/load run and ClickHouse row count and
   `extracted_at` freshness increase before the recurring schedule is enabled.

Until then, team members must not claim IRIS analytics ingestion is complete,
unpause the recurring DAG, backfill synthetic rows, infer missing telemetry
semantics, or access the IRIS production database directly.

Dedicated read-only API for the LaundryTwin analytics stack (ClickHouse + Airflow + Superset) to pull machine usage and operational data from IRIS Neon. Server-held credential, tenant-bound, cursor-paginated.

## Authentication

- Header: `X-LaundryTwin-Read-Key` (constant-time compare)
- Server holds secret; browser never sees it
- Credential maps to exactly one configured tenant
- Returns 401 for invalid key, 503 if secret not configured

## Endpoints

### GET /v1/laundrytwin/branches

Returns branch list with tenant scope.

**Query params:**
- `cursor` (optional) — opaque string for pagination
- `limit` (optional, default 100, max 500)

**Response:**
```json
{
  "contractVersion": "2026-08-08",
  "branches": [
    {
      "branchId": "uuid",
      "name": "string",
      "timezone": "Asia/Bangkok",
      "active": true
    }
  ],
  "nextCursor": "opaque|string|null",
  "fetchedAt": "ISO8601"
}
```

### GET /v1/laundrytwin/machines

**Query params:**
- `branchId` (optional uuid) — must be within tenant
- `cursor` (optional)
- `limit` (optional, default 100, max 500)

**Response:**
```json
{
  "contractVersion": "2026-08-08",
  "machines": [
    {
      "machineId": "uuid",
      "branchId": "uuid",
      "machineCode": "string",
      "machineKind": "washer|dryer",
      "modbusAddress": "int",
      "active": true
    }
  ],
  "nextCursor": "opaque|string|null",
  "fetchedAt": "ISO8601"
}
```

### GET /v1/laundrytwin/usage

**Query params:**
- `branchId` (optional uuid) — must be within tenant
- `updatedAfter` (optional ISO8601) — cursor for incremental sync
- `afterId` (optional uuid) — tie-breaker when timestamps equal
- `limit` (optional, default 500, max 2000)
- `status` (optional enum) — pending_payment|paid|running|finished|cancelled

**Response:**
```json
{
  "contractVersion": "2026-08-08",
  "rows": [
    {
      "usageId": "uuid",
      "branchId": "uuid",
      "machineId": "uuid",
      "sourceEventId": "string",
      "machineSessionId": "string|null",
      "startedAt": "ISO8601|null",
      "finishedAt": "ISO8601|null",
      "durationMin": "int",
      "programId": "int",
      "programName": "string",
      "tempLevel": "cold|warm|hot|low|medium|high|null",
      "amountSatang": "int",
      "status": "pending_payment|paid|running|finished|cancelled",
      "initiatedVia": "staff_v3|liff|kiosk_k2",
      "attributionState": "exact|legacy|heuristic|pending_attribution",
      "attributionSource": "staff_v3|liff|handheld_dispatch|unknown",
      "sourceCreatedAt": "ISO8601",
      "sourceUpdatedAt": "ISO8601"
    }
  ],
  "nextCursor": "opaque|string|null",
  "fetchedAt": "ISO8601"
}
```

Cursor encoding: base64(`updatedAt|usageId`) where `updatedAt` is `source_updated_at` from source.

### GET /v1/laundrytwin/machine-events

**Query params:**
- `branchId` (optional uuid)
- `occurredAfter` (optional ISO8601)
- `afterId` (optional string) — event_id tie-breaker
- `limit` (optional, default 500, max 2000)
- `kind` (optional) — state_change|command_executed|error|offline_detected

**Response:**
```json
{
  "contractVersion": "2026-08-08",
  "rows": [
    {
      "eventId": "string",
      "branchId": "string",
      "machineId": "string",
      "seq": "int64",
      "frameSeq": "int64|null",
      "occurredAt": "ISO8601",
      "ingestedAt": "ISO8601",
      "kind": "state_change|command_executed|error|offline_detected",
      "phase": "IDLE|PAID|RUNNING|FINISHED|ERROR|OFFLINE|MAINTENANCE|ARMED|RUN_HEAT|RUN_COOL|POST_CYCLE|null",
      "prevPhase": "string|null",
      "state": { ... }
    }
  ],
  "nextCursor": "opaque|string|null",
  "fetchedAt": "ISO8601"
}
```

Cursor: base64(`occurredAt|eventId`).

### GET /v1/laundrytwin/temperature-samples

**Query params:**
- `branchId` (optional uuid)
- `occurredAfter` (optional ISO8601)
- `afterId` (optional string)
- `limit` (optional, default 500, max 2000)

**Response:**
```json
{
  "contractVersion": "2026-08-08",
  "rows": [
    {
      "eventId": "string",
      "branchId": "string",
      "machineId": "string",
      "seq": "int64",
      "frameSeq": "int64|null",
      "occurredAt": "ISO8601",
      "ingestedAt": "ISO8601",
      "temperatureF": "int",
      "temperatureC": "float|null",
      "phase": "string|null"
    }
  ],
  "nextCursor": "opaque|string|null",
  "fetchedAt": "ISO8601"
}
```

Cursor: base64(`occurredAt|eventId`).

## Error Codes

- `401` `UNAUTHORIZED` — missing/invalid read key
- `403` `FORBIDDEN` — branchId not in tenant scope
- `400` `BAD_REQUEST` — invalid cursor, limit, date format
- `503` `READ_API_NOT_CONFIGURED` — secret not configured
- `500` `INTERNAL` — unexpected

## Rate Limits

- 60 req/min per credential (enforced at edge)

## Contract Versioning

- `contractVersion` in every response
- Breaking change = new version in path (`/v2/...`)
- Non-breaking additions = same version, new optional fields
- Deprecated fields remain for ≥2 versions

## Non-Functional

- Response time p95 < 500ms (cached branch/machine lists)
- Cursor stable across schema additions
- Idempotent reads — no side effects
- No PII in responses (member names excluded from usage rows)

---

*This design supplements the optional reporting integration documented in `docs/integration/iris-laundrytwin-read-api.md`. The historical `X-LaundryGo-Read-Key` header and `/v1/laundrygo` path remain the reporting wire contract for existing consumers; the target machine-usage export is a separate `/v1/laundrytwin` contract.*