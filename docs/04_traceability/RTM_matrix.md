# 🔗 Requirements Traceability Matrix (RTM)

**Document Purpose:** This matrix connects CE Project requirements to system
functions and user stories. Function names follow
`docs/01_requirements/system_functions.md`; implementation status below records
local code and test evidence, not production E2E verification.

## Traceability

| Domain / Feature | User Story (US) | Requirement (R) | System Function (F) | Phase |
| :--- | :--- | :--- | :--- | :--- |
| **Telemetry pipeline (via IRIS)** | US-10 | R01, R02 | F-04 (Telemetry Data Streaming; target), F-05 (MQTT Ingestion & Data Pipeline; current ETL path) | **MVP** |
| **RBAC & multi-tenant security** | US-09, US-11 | R04 | F-06 (RBAC), F-07 (Authentication & Audit Log) | **MVP** |
| **Digital Twin / machine status** | US-02 | R02, R04 | F-01 (Virtual Presence & State Sync) | **MVP** |
| **Business dashboard** | US-04 | R03, R04 | F-08 (KPI Aggregation & Data Export) | **MVP** |
| **Gas early-warning system** | US-01 | R05, R06 | F-02 (Estimated Gas Remaining), F-10 (Event-Driven Alert Engine) | **MVP** |
| **Coin-box estimation** | US-03 | R05, R07 | F-09 (Estimated Coin-Box Fill & Reset), F-10 | **MVP** |
| **AI executive summary** | US-05 | R04, R08 | F-11 (Safe Analytics Function Calling) | **MVP** |
| **Rule-based maintenance alert** | US-08 | R05, R10 | F-10 | **MVP** |
| **AI smart promotion** | US-06 | R09 | No F-ID assigned here; see F-12 ambiguity note | _Phase 2_ |
| **Spatial anomaly diagnostics** | US-08 | R10 | F-03 (Spatial Layout & Error Correlation) | _Phase 2_ |
| **Customer web view** | US-07 | R11 | F-13 (Public Machine Status API) | _Phase 2_ |
| **Weather demand analysis** | US-06 | R12 | F-12 (External Context — Weather API) | _Phase 2_ |

### F-12 ambiguity

`system_functions.md` defines F-12 as **External Context (Weather API)**.
Older planning and traceability material also used the F-12 label for the
off-peak recommendation work. This matrix does not invent a new function ID:
the weather item remains F-12/R12, while the off-peak baseline remains
US-06/R09 and is evidenced through the `get_off_peak_windows` MCP tool.

**Weather schema extension (2026-09-22):** `dim_branch_location` and
`fact_weather_sample` include nullable `sub_district` and `district` fields for
future per-position data. The current `fact_weather_sample` key is
`(tenant_id, branch_id, timestamp)`, not `(province, timestamp)`.

---

## How to maintain this document

- Before building a feature, find its `F-ID`, `R-ID`, and `US-ID` here and
  confirm the authoritative function name in `system_functions.md`.
- A local test result does not prove staging, LINE, or browser E2E behavior.
- Mark partial coverage as partial when the implementation does not satisfy the
  full acceptance criteria or lacks a complete audit/evidence path.

## Implementation status (as of 2026-09-25)

| Function | Status | Local evidence and remaining boundary |
| :--- | :--- | :--- |
| F-01 State Sync | Partial | Direct Digital Twin reports retain active inventory, preserve unknown state, and expose usage-derived freshness; `fact_machine_event` is empty and current state is not live telemetry. |
| F-04 Telemetry Data Streaming | Not implemented directly | Direct MQTT streaming and a WebSocket/SSE client stream are not current implementation. The deployed batch path is represented by F-05 through IRIS → ClickHouse ETL. |
| F-05 MQTT Ingestion & Data Pipeline | Implemented on current IRIS path | `apps/etl/` performs validated, watermark-based, idempotent loading into ClickHouse. The original direct MQTT path is descoped. |
| F-06 RBAC | Implemented in local code/tests | `apps/api/src/access-policy.ts`, report/analytics scope gates, and denial tests constrain every tenant-scoped query. Production E2E remains pending. |
| F-07 Authentication & Audit Log | Partial | Better Auth requires `BETTER_AUTH_SECRET` outside tests, public signup is disabled, and rate limits are enabled. Local audit entries exist for grants, alerts, and settings; there is no complete AI prompt/tool-call audit table. |
| F-08 KPI Aggregation & Data Export | Implemented locally | Direct ClickHouse Dashboard/Twin reports and analytics endpoints use bound dates and branch parameters, nullable revenue redaction, and visible source/freshness/availability metadata. Production E2E remains pending. |
| F-10 Event-Driven Alert Engine | Implemented locally | `apps/api/src/alert-engine.ts` tests idempotency, cooldowns, recipient scope, evidence, failure retry, and local alert acknowledgement. |
| F-11 Safe Analytics Function Calling | Partial | Six allow-listed MCP tools are current. `accessScope` is not a model argument; LINE scope is server-derived and signed. `MCP_ACCESS_TOKEN` is required and `MCP_ALLOW_REVENUE` is explicit false by default. Arbitrary SQL has no path, but a complete prompt/tool-call/result audit is still absent. |
| F-12 External Context — Weather API | Implemented baseline | TMD weather collection runs hourly (`sleep 3600`), is branch-tagged, and inserts nullable readings into `fact_weather_sample`; correlation is descriptive, not a forecast. |
| US-06/R09 off-peak baseline | Implemented as a Phase 2 baseline | `get_off_peak_windows` uses a percentile heuristic over `fact_machine_usage`; it is not assigned a new F-ID. |

## Current MCP tool names

The current server exposes exactly these six allow-listed tools:

- `get_revenue_daily`
- `get_cycles_daily`
- `get_utilization_heatmap`
- `get_temperature_curve`
- `get_weather_usage_correlation`
- `get_off_peak_windows`

MCP access uses a service bearer token. The LINE bot signs a per-session scope
derived from server-resolved grants; scope is not supplied by the model. The
current analytics envelope is `{ meta, data }`, not the richer target envelope
shown in presentation material.
