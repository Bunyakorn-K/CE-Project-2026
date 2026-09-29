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

### Canonical cycle definition (decided 2026-09-29)

**The canonical definition of a cycle is the count of usage ROWS with
`status IN (2, 4)`.** It is used by every surface that labels a number
"รอบ" (cycle). Owner-approved; decided on real data, not on inference.

| Surface | Query | Status |
| :------ | :----- | :----- |
| `/api/report/dashboard` KPI `cycles` | `countIf(u.status IN (2, 4))` | **Canonical** |
| dashboard twin tab `cycleCount` | `countIf(u.status IN (2, 4))` | **Canonical** (was `countDistinct(machine_session_id)`, no status filter) |
| `/api/v1/analytics/cycles/daily` `cycles` | `countIf(status IN ('finished','paid'))` | Already canonical; unchanged |
| `/api/v1/analytics/utilization` `cycles` | `count()`, no status filter | Deliberately **unfiltered**: it is a utilisation denominator, not a cycle count, and must include every row a machine was busy. Not a cycle KPI and not held to this definition. |

Sources: `apps/api/src/report/clickhouse-report.ts` (`buildDashboardSQL`,
`buildMachineStateSQL`) and `apps/api/src/analytics/queries.ts:31-33`.

#### The evidence, and where it comes from

`apps/api/scripts/cycle-cardinality-diagnostic.ts` — read-only, SELECT-only,
env-driven, and it refuses to report a verdict when `fact_machine_usage` holds
no non-synthetic rows, so seed data can never be mistaken for a finding. Run
against the **real** production warehouse on **2026-09-29** over 4,458
non-synthetic rows spanning **2026-07-22 → 2026-09-25 (9 weeks)**:

1. **Cardinality is 1:1.** 1,609 session ids; min = max = 1 rows per session;
   0 session ids spanning more than one row; 0 session ids carrying more than
   one `status`. So for an *attributed* row, counting rows and counting
   sessions are the same measurement, and the two families of definition could
   only differ through *missing* attribution.
2. **Attribution is mostly missing.** 63.91% of rows (2,849 of 4,458) have a
   NULL `machine_session_id`, and that null set is exactly
   `attribution_state = 'pending_attribution'` (2,850 pending vs 1,610 exact).
3. **The price band is decisive.** Real revenue is 16,480,000 satang (฿164,800):

   | definition | count | ฿/cycle | plausible? |
   |---|---|---|---|
   | `uniqExactIf(machine_session_id, status IN (2,4))` — **what the KPI used** | 1,314 | ฿125.42 | no — ~3× a real wash |
   | `countDistinct(machine_session_id)`, no status filter — twin tab | 1,609 | ฿102.42 | no |
   | **`countIf(status IN ('finished','paid'))` — row count** | **3,905** | **฿42.20** | **yes — a Thai wash is ฿40–45** |
   | `count()`, no filter | 4,458 | ฿36.97 | roughly, but includes cancelled work |

   **The dashboard KPI was counting 1,314 of 3,905 — it silently dropped 66% of
   cycles and showed no signal that the data was incomplete.** That is the
   defect this decision fixes.

#### Why rows, and not sessions

- **It is the only definition that counts every session.** A session-distinct
  count discards the 2,849 unattributed rows, and those rows are real usage.
- **The cardinality measurement means nothing is lost by counting rows.** One
  session id is exactly one row, so `countIf(...)` and
  `countDistinct(machine_session_id)` would be identical over the attributed
  subset. The row count is a strict superset.
- **It aligns the dashboard with the analytics layer.** `DAILY_SQL` already
  used `countIf(status IN ('finished','paid'))`. This removes a divergence
  rather than creating one.
- **The status filter is a data-contract decision and is untouched.**
  `docs/03_data_contracts/data_contracts.md` authorises `status IN (2, 4)` for
  revenue and cycle counts. Revenue aggregation is **unchanged** — it is
  separately correct, separately tested, and separately verified.

#### The attribution gap stays visible

A correct number that is silently incomplete is still misleading, so the
dashboard response now carries `dashboard.cycleAttribution`
(`{ countedRows, attributedRows, unattributedRows }`), computed from the same
query as `cycles`, and the web dashboard states the gap in Thai directly under
the KPI. `machine_session_id` is **not** used to compute the cycle count; it is
used only to report how much of that count has session-level evidence behind
it. On the IRIS/demo path the field is `null`, because that source cannot
measure attribution at all.

The twin tab's `cycleCountSource` was `"machine_session_id"`, which was honest
while the count came from that field and would have become a lie the moment it
did not. It is now `"usage_row" | "unavailable"`, and the Thai card label moved
with it.

#### Corrections this evidence forced

- `docs/06_ml/ml-training-data-guide.md` claimed "Every row in
  `fact_machine_usage` represents one machine session". That is **wrong about
  the real data** and is corrected rather than deleted: a row is one usage
  event, one session id spans exactly one row, and 63.91% of rows carry no
  session id at all.
- `paid_ratio` was documented as a bare `Float64`. On real data it is
  **undefined, not zero**, when a branch-day has no `paid` and no `finished`
  row, and `paid` appears on only 257 rows of which **6** carry a session id.
  It is now `Nullable(Float64)` with `nullIf(..., 0)`.
- "~4.8k usage rows (~1 week)" was wrong in four places
  (`AGENTS.md`, `README.md`, `docs/06_ml/ml-training-data-guide.md`,
  `docs/06_ml/algorithm-comparison.md`). The warehouse holds 4,458 non-synthetic
  rows over 9 weeks. Still far too little for time-series modelling.
- `machine_session_id` had no entry in
  `docs/03_data_contracts/data_contracts.md` at all. It has one now, recording
  only what is evidenced: nullable, pass-through from IRIS, present on ~36% of
  real rows, exactly correlated with `attribution_state = 'pending_attribution'`,
  one row per session where present, upstream attribution semantics
  **unresolved**.

#### Scope of the evidence

This is a measurement of the production warehouse, run read-only through
`SELECT` statements, recorded in this repository. It is **not** a production,
LINE, or browser E2E verification of the changed dashboards, and it does not
establish what the KPI looks like in a real branch. The only automated evidence
for the code change is local: `apps/api` and `apps/web` unit tests plus a
manual run of the built web bundle against the **synthetic** local warehouse,
where 59.2% of counted rows lack a session id and session ids can span up to
three rows — a property the real data does not have.

Re-run the diagnostic to reproduce the finding. The command, the connection
facts this repository does document, and the credential and reachability
details it does **not** document are in `docs/02_architecture/deploy-runbook.md`,
"Read-only warehouse diagnostic: cycle cardinality".

---

## How to maintain this document

- Before building a feature, find its `F-ID`, `R-ID`, and `US-ID` here and
  confirm the authoritative function name in `system_functions.md`.
- A local test result does not prove production, LINE, or browser E2E behavior.
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
