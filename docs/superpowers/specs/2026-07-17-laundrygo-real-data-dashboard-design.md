# LaundryGo Real-Data Dashboard Design

## Status

Approved architecture pending implementation planning. LaundryGo remains a
standalone final-project application. IRIS is an external, read-only data
provider and remains the source of truth for operational machine data.

## Goals

- Replace fixed seed values with real, traceable operational data from IRIS.
- Provide a mobile-first LINE LIFF dashboard for stakeholders.
- Keep LaundryGo authentication, user administration, roles, branch scopes,
  sessions, and audit records independent from IRIS.
- Enforce a read-only integration boundary: LaundryGo must never issue machine
  commands, create payments, alter telemetry, or access the IRIS database,
  MQTT broker, or Durable Objects directly.
- Cover the MVP reporting requirements: live machine state, KPI aggregation,
  scoped access, alerts, coin-box evidence, and a safe executive summary.

## Non-Goals

- Replacing IRIS telemetry ingestion, MQTT validation, payment processing, or
  existing operator backoffice workflows.
- Mirroring production data into the LaundryGo SQLite database.
- Presenting a value as live, calculated, or sensor-backed when the source
  integration cannot provide it.
- Implementing Phase 2 promotion, predictive maintenance, public customer
  status, or weather analytics in the first delivery.

## System Boundary

```text
LINE LIFF client
    |
    | verified LINE identity
    v
LaundryGo web and Hono API on the VM
    |                         |
    | local session/RBAC      +--> SQLite: users, scopes, approvals, audit
    |
    | server-to-server read credential
    v
IRIS read API
    |                    |
    +--> live-state projection
    +--> machine events, usage, transactions, alert evidence, aggregates
```

The browser calls LaundryGo only. The IRIS integration credential is held by
the LaundryGo server and is never returned to the client. The IRIS read API
maps that credential to an allowed tenant and rejects any request outside that
tenant before querying data.

## Authentication and Authorization

### Stakeholder sign-in

1. The LIFF client obtains a LINE ID token.
2. `POST /api/liff/session` sends the token to the LaundryGo API.
3. LaundryGo verifies the token against LINE for the configured channel and
   validates issuer, audience, expiry, and subject.
4. LaundryGo looks up the stable LINE subject in `stakeholder_identity`.
5. An approved identity receives a short-lived, HttpOnly LaundryGo session.
   An unknown or revoked identity receives no data and sees a pending or
   denied access state.

LIFF identity is intentionally separate from Better Auth. Better Auth remains
the local administrator session mechanism. This avoids relying on an
unverified assumption that a LIFF ID-token exchange is a Better Auth social
OAuth callback.

### Local roles and branch scopes

The local administrator approves an access request and assigns one of these
roles plus zero or more branch scopes:

| Role | Scope | Read capabilities |
| --- | --- | --- |
| Owner | All tenant branches | KPI, revenue, utilization, alerts, machine state, exports, executive summary |
| Manager | Assigned branches only | KPI, alerts, machine state, exports, executive summary for assigned branches |
| Technician | Assigned branches only | Machine state, telemetry evidence, technical alerts, coin-box and gas evidence |

Every LaundryGo request derives its role and branch set from the server-side
session. Client-supplied tenant or branch identifiers are treated only as
filters within that already-authorized set.

Local writes are limited to access requests, approval or revocation, role and
scope changes, alert acknowledgement when enabled, and append-only audit
records. They do not modify IRIS operational data.

## IRIS Read Integration Contract

IRIS must expose a versioned, server-to-server, read-only contract dedicated
to LaundryGo. It must not expose database credentials or a generic SQL API.

Required resources:

| Resource | Purpose |
| --- | --- |
| `GET /v1/laundrygo/branches` | Branch names, timezone, status, and source coverage |
| `GET /v1/laundrygo/dashboard` | Period KPI: revenue, cycles, utilization, and counts |
| `GET /v1/laundrygo/branches/:branchId/live` | Current machine snapshots and freshness metadata |
| `GET /v1/laundrygo/events` | Paginated normalized event evidence for diagnostics and alerts |
| `GET /v1/laundrygo/alerts` | Alert state, rule id/version, trigger evidence, and cooldown state |
| `GET /v1/laundrygo/summary-input` | Whitelisted aggregate facts for executive summaries |

The initial live endpoint may be polled by LaundryGo at a bounded cadence. The
LaundryGo API exposes an SSE stream to LIFF clients with reconnect support and
falls back to REST refresh. This preserves a near-real-time interface without
giving the browser an IRIS credential.

Every response includes `contractVersion`, `source`, `fetchedAt`, and
per-record `eventTimestamp` or `lastSeen`. A record must include its machine
and branch identities. The contract supports the following required fields
when their IRIS producer exists:

```text
branchId, machineId, registerMapVersion, eventTimestamp, state,
remainingSeconds, temperatureC, paidCounter or transactionEvent,
doorStatus, coinboxOpen, gasPressure, gasLeakDetected, ruleId, ruleVersion
```

Missing producer fields are represented as absent coverage with an explicit
reason, never as zero, normal, or estimated values. For example, gas features
remain unavailable until a verified gas sensor source is exposed by IRIS.

## Dashboard Features

### Operational dashboard

- Branch and period selector constrained by the local role scope.
- Real machine state with phase, remaining time, temperature when available,
  door state, source mapping version, event time, and freshness status.
- Revenue, cycle count, and utilization calculated from IRIS aggregates.
- Attention queue with alert severity, rule version, evidence timestamp, and
  acknowledgement state.
- Coin-box level only when it has calibrated source evidence. A reset is shown
  only after a verified `coinbox_open` event.
- Gas status only when pressure or leak data is supplied. Unsupported coverage
  is rendered as unavailable rather than healthy.

### Reporting and export

- Owner and Manager may select a permitted branch set and time range.
- Exports contain aggregate operational data only; no customer identifiers or
  LINE identity values are included.
- Each report carries source, generated time, data range, and freshness
  metadata.

### Executive summary

The summary feature calls a fixed allowlist of aggregate tools, such as
`getKpi`, `getBranchComparison`, `getAlertCounts`, and `getDataCoverage`.
It never lets a model construct SQL, call arbitrary endpoints, or access raw
telemetry or personal data. Calls and returned source facts are audit logged.

Cloudflare AI is an optional provider behind this tool boundary. If it is not
configured or fails, LaundryGo renders a deterministic summary from the same
facts and states that an AI-generated summary is unavailable. It must not
invent a narrative from missing data.

## Data Quality and Alert Rules

- IRIS remains responsible for ingesting and validating MQTT or edge telemetry
  (Requirement R01). LaundryGo surfaces validation outcome and data coverage
  as read-only evidence.
- LaundryGo evaluates local reporting alert rules only from normalized,
  timestamped data. Each alert is deduplicated by rule, target, and cooldown.
- An alert includes the source event, rule id, rule version, trigger time, and
  delivery or acknowledgement state.
- The initial application must clearly distinguish observed telemetry,
  calculated metrics, unavailable sensors, and degraded data freshness.

## Persistence Model

LaundryGo SQLite stores only application-owned data:

- Better Auth tables for local administrator accounts and sessions.
- `stakeholder_identity` for the verified LINE subject and display profile.
- `stakeholder_access_request` for pending approval state.
- `stakeholder_access_scope` for role, tenant binding, branch bindings,
  approval state, and revocation state.
- `local_alert_rule`, `local_alert_event`, and `local_audit_log` for
  application-owned reporting behavior.
- Short-lived cache entries only when needed for SSE fan-out. Telemetry history
  and revenue data are not persisted as a production mirror.

## Acceptance Criteria

1. A non-approved LIFF identity cannot retrieve dashboard data.
2. A Manager cannot request a branch outside its local branch scope.
3. The IRIS read credential cannot access a tenant outside its configured
   scope, even if LaundryGo submits a modified query parameter.
4. Dashboard data is derived from the IRIS contract, with no fixed demo
   revenue, machines, alerts, or misleading live indicator.
5. Every live card displays freshness and source metadata; missing fields are
   explicitly unavailable.
6. Alert events include rule version, evidence, cooldown behavior, and an
   audit trail for acknowledgement.
7. Executive summaries use only allowlisted aggregate tools and never contain
   data from another tenant or outside the caller's branches.
8. Machine command, payment, telemetry mutation, and direct database routes
   are absent from the LaundryGo public API.

## Verification Strategy

- Unit tests for LIFF token verification boundaries, pending approval,
  revocation, local role checks, branch filtering, alert deduplication, and
  summary-tool allowlisting.
- Contract tests with recorded, non-sensitive IRIS API fixtures for valid,
  invalid, missing, stale, and cross-tenant responses.
- API tests proving that no client request can widen the role, branch, or
  tenant scope.
- Browser tests at a phone viewport for LIFF sign-in, unavailable coverage,
  freshness states, dashboard data, and SSE reconnect fallback.
- Production deployment and real-data cutover occur only after an explicit
  user request, a scoped IRIS credential, preflight evidence, and a rollback
  plan.

## Delivery Sequence

1. Define and test the IRIS read-only integration contract.
2. Replace LaundryGo demo persistence and endpoints with local access control
   plus an IRIS data adapter.
3. Build the mobile dashboard from contract data and truthful data-quality
   states.
4. Add local approval, role/scope administration, alerts, audit, and export.
5. Add the safe executive summary provider and enable Cloudflare AI only when
   its configuration and access boundary are available.
