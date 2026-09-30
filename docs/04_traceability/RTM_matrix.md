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

**The canonical definition of a cycle is the count of usage ROWS whose status
is `paid` or `finished`** — written `status IN ('paid', 'finished')`. It is used
by every surface that labels a number "รอบ" (cycle). Owner-approved; decided on
real data, not on inference.

**Filter by name, not by enum number.** The dashboard previously wrote
`status IN (2, 4)`, which was only correct under the old enum numbering.
`status` is now numbered by the IRIS lifecycle order
(`docs/03_data_contracts/data_contracts.md`, "status enum numbering"), under
which those integers name `paid` and `running`. The set of rows is unchanged;
only the spelling is now stable. Verified on ClickHouse 26.3 that a string
literal resolves against an `Enum8` by name.

| Surface | Query | Status |
| :------ | :----- | :----- |
| `/api/report/dashboard` KPI `cycles` | `countIf(u.status IN ('paid', 'finished'))` | **Canonical** |
| dashboard twin tab `cycleCount` | `countIf(u.status IN ('paid', 'finished'))` | **Canonical** (was `countDistinct(machine_session_id)`, no status filter) |
| `/api/v1/analytics/cycles/daily` `cycles` | `countIf(status IN ('finished','paid'))` | Already canonical; unchanged |
| `/api/v1/analytics/utilization` `cycles` | `count()`, no status filter | Deliberately **unfiltered**: it is a utilisation denominator, not a cycle count, and must include every row a machine was busy. Not a cycle KPI and not held to this definition. |

Sources: `apps/api/src/report/clickhouse-report.ts` (`buildDashboardSQL`,
`buildMachineStateSQL`) and `apps/api/src/analytics/queries.ts:31-33`.

#### The evidence, and where it comes from

`apps/api/scripts/cycle-cardinality-diagnostic.ts` — read-only, SELECT-only,
env-driven, and it refuses to report a verdict when `fact_machine_usage` holds
no non-synthetic rows, so seed data can never be mistaken for a finding.

> **The decision was taken on the 2026-09-29 measurement, and that measurement
> stands as the evidence for it.** The figures recorded below under
> "2026-09-29" are the ones the decision was made on, on a corpus that did sit
> inside the plausible ฿40–45 band. A later re-measurement (2026-09-30, after
> the warehouse recovery merge) is recorded in the next block. It **does not
> re-confirm the decision**: on the larger corpus the row count reads ฿48.40,
> *above* the band. It also does not invalidate the decision, does not replace
> the 2026-09-29 numbers as its basis, and does not change the **ranking**, in
> which the row count is still the only defensible one of the four. Read the
> 2026-09-30 band as new evidence on a different corpus, not as a verdict.
> Every figure carries its own measurement date, because the unattributed
> share, the row count, and the ฿/cycle ratio all move as the ETL ingests the
> IRIS backlog and as recovery merges land.

**2026-09-29 — the measurement the decision rests on.** Run against the **real**
production warehouse on **2026-09-29** over 4,458 non-synthetic rows spanning
**2026-07-22 → 2026-09-25 (9 weeks)**:

1. **Cardinality is 1:1.** 1,609 session ids; min = max = 1 rows per session;
   0 session ids spanning more than one row; 0 session ids carrying more than
   one `status`. So for an *attributed* row, counting rows and counting
   sessions are the same measurement, and the two families of definition could
   only differ through *missing* attribution.
2. **Attribution is mostly missing.** 63.91% of rows (2,849 of 4,458) have a
   NULL `machine_session_id`, and that null set corresponds to
   `attribution_state = 'pending_attribution'` (2,850 pending vs 1,610 exact).

   > **The word "exactly" was not supported here and has been removed.** Two
   > arithmetic gaps sit in these figures and neither was explained when this
   > block was written on 2026-09-29: the NULL count (2,849) is **one row
   > short** of the `pending_attribution` count (2,850), and the two
   > `attribution_state` counts sum to **4,460 against a 4,458-row corpus** —
   > a two-row surplus. The one-row gap has the same shape as the
   > 5,146-row measurement reconciled below (a row with `machine_session_id`
   > populated but `attribution_state` still `pending_attribution`), so the
   > columns are demonstrably independent. The two-row surplus is a **separate,
   > unreconciled** discrepancy: it implies the `attribution_state` breakdown was
   > read at a different moment, or over a slightly different row set, than the
   > 4,458 corpus figure. **That has not been re-measured and no cause is
   > claimed.** Treat the two columns as near-but-not-identical, and do not use
   > this block to argue the correspondence is exact. The 2026-09-30 measurement
   > has the same one-row gap (5,369 vs 5,368) but its counts do sum correctly
   > (5,368 + 2,540 = 7,908).

> **The unattributed share is a live metric, not a constant.** It rises as the
> ETL ingests the IRIS backlog, because backlog rows are the historical ones
> that predate session attribution. Re-measured **2026-09-29 15:45Z** over
> 5,146 rows: **65.25%** (3,358 rows with a NULL `machine_session_id`;
> 3,357 `pending_attribution` vs 1,789 `exact`). The gap between 3,358 and
> 3,357 is one row whose `machine_session_id` is populated but whose
> `attribution_state` is still `pending_attribution` — the two columns are
> independent, so treat the share as approximate and always state the
> measurement date. Any figure quoted without one is stale by construction.
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

**2026-09-30 — current measurement, taken after the warehouse recovery merge**
(`docs/04_traceability/ops-verification-2026-09-30-warehouse-data-recovery.md`;
measured **2026-09-30 11:39:11 UTC** over **7,908** non-synthetic rows spanning
**2026-07-22 → 2026-09-30 (71 calendar days)**):

- **Volume and shape.** 7,908 rows; `countDistinct(tenant_id, branch_id,
  usage_id)` is also 7,908, so the `ReplacingMergeTree` key is 1:1 and the merge
  introduced no key collision. 7,911 rows raw (non-`FINAL`), so 3 rows in the
  live table are replaceable duplicates. (Whether those 3 relate to the merge's
  27 recorded overlaps was not established.)
- **Attribution.** **67.8933% of rows (5,369 of 7,908) have a NULL
  `machine_session_id`**, measured twice (11:35:11Z and 11:39:11Z) with an
  identical result. `attribution_state` breaks down as 2,540 `exact` vs 5,368
  `pending_attribution` (67.8806%); the one-row difference between 5,369 and
  5,368 is the same `machine_session_id`-populated /
  `pending_attribution`-set inconsistency noted above, so the share stays
  approximate. `countDistinct(machine_session_id)` is 2,539 and
  `uniqExactIf(machine_session_id, status IN ('paid','finished'))` is 1,589.
- **Price band, re-measured.** Revenue is 33,617,000 satang (฿336,170) over all
  rows and **32,265,000 satang (฿322,650) over `status IN ('paid','finished')`**.
  The first three rows below divide the paid/finished numerator; the unfiltered
  `count()` row divides the **all-rows** numerator, because an unfiltered row
  count has to be divided by all rows' revenue to be a like-for-like ฿/row.

  | definition | count | numerator | ฿/cycle | plausible? |
  |---|---|---|---:|---|
  | `uniqExactIf(machine_session_id, status IN ('paid','finished'))` | 1,589 | ฿322,650 paid/finished | ฿203.05 | no — ~4.5× a real wash |
  | `countDistinct(machine_session_id)`, no status filter | 2,539 | ฿322,650 paid/finished | ฿127.08 | no — ~2.9× a real wash |
  | **`countIf(status IN ('paid','finished'))` — row count** | **6,666** | ฿322,650 paid/finished | **฿48.40** | **just above the ฿40–45 band** |
  | `count()`, no filter | 7,908 | **฿336,170 all rows** | ฿42.51 | inside the band, but **not a cycle count** |

  **The band does not hold on this corpus, and this is recorded as the opposite
  of a confirmation.** The row-count definition now reads **฿48.40/cycle,
  above the plausible ฿40–45 range** for a Thai self-service wash. The only
  definition landing inside the band is the unfiltered `count()`, which this
  document has already rejected as a cycle count because it sweeps in
  cancelled, admitted, and running work. The decision is unchanged, and it
  rests on the 2026-09-29 evidence above, which was collected on a corpus that
  did sit inside the band; the 2026-09-30 numbers neither re-confirm nor refute
  it, because the corpus underneath it changed.

  What the refreshed numbers **do** support is the **ranking**. The row count
  remains the closest of the four to a real wash, and the two session-distinct
  definitions remain implausible at roughly **3× to 5×** a ฿40–45 wash
  (฿127.08 and ฿203.05) — far enough out that no plausible Thai wash price makes
  either of them the better answer, so the choice among the four is unchanged.
  The gap has also
  widened with the recovered backlog: only 1,589 of 6,666 cycles (23.84%) carry
  a session id, so **76% of cycles have no session-level evidence**.

  **Why ฿/cycle rose from ฿42.20 to ฿48.40 — MEASURED 2026-09-30 12:15–12:45
  UTC, hypothesis CONFIRMED** (recovery record **§5A**). The recovered 17 days
  are **72.6929%** unattributed against the pre-existing corpus's **61.7752%**,
  and they supply **95.01%** of their own `paid`/`finished` rows as
  unattributed against the complement's **66.35%**. Per group under the
  canonical row count: recovered days alone **฿59.92**, complement alone
  **฿41.88**, all rows **฿48.41**.

  The mechanism is a **row-mix effect, not a price effect**: revenue per
  unattributed `paid`/`finished` row is **6,306 satang** in the recovered days
  against **6,273.4** in the complement — a 0.5% difference. The two periods
  cost the same per cycle; what differs is how much of each period's row count
  is revenue-bearing. A counterfactual that reassigns the recovered days' rows
  to the complement's attribution mix, holding each group's own
  revenue-per-row, reads **฿43.05 — inside the plausible band**, so
  attribution mix accounts for the overshoot and nothing else measured here
  does.

  > **This does not re-confirm the decision; it weakens it.** The ฿/cycle
  > agreement is now *explained*, and what it explains is that the ratio reads
  > like a plausible wash partly **because unattributed rows are cheap per
  > session** — not because a row is a wash. A metric that lands in the band
  > for that reason has not thereby been validated. The 2026-09-29 decision
  > stands on its own evidence and the **ranking is unchanged**; do not
  > describe this measurement as strengthening it.
  >
  > Two things remain **unexplained** and are not claimed: why
  > 2026-07-22 → 2026-08-20 is only **6.53%** unattributed and reads
  > **฿3.35/cycle** (it is not recovered data, and it is why the corpus-wide
  > unattributed share is as low as 67.87%); and whether **฿63 per
  > unattributed cycle** is a *correct* wash price at all — this measurement
  > shows the two periods agree on it, not that it is right.
- **`status` breakdown** (measured 2026-09-30 11:39:11 UTC): `pending_payment` 2,
  `paid` 262, `admitted` 28, `running` 972, `finished` 6,404, `cancelled` 240.
  533 rows have a NULL `started_at`. The canonical cycle KPI
  `countIf(status IN ('paid','finished'))` is **6,666** on this measurement.
  **Whether those 262 `paid` rows carry a `machine_session_id` was not
  re-measured** — the 6-of-257 figure below is a 2026-09-29 measurement and is
  not superseded, it is simply not refreshed.
- **Coverage.** 70 distinct day buckets across the 71 calendar days
  2026-07-22…2026-09-30; every one of the 17 days 2026-08-31…2026-09-16 now
  has rows. 2026-07-27 is the only usage gap day and is a genuine source gap.
  The 2026-09-30 merge recovered a 17-day hole in the live warehouse. Its
  **root cause is resolved: no data was deleted** — the 17 days were orphaned
  by the 2026-09-17 rollback, not destroyed, and have been merged back. The
  residual risk is that the *procedure* is still unguarded: another restore
  could still lose a different window, and the two restore-time guards
  (restore-source freshness assertion, post-restore `max(extracted_at)`
  continuity check) remain open. See
  `docs/04_traceability/ops-verification-2026-09-30-warehouse-data-recovery.md` §1.

#### Why rows, and not sessions

- **It is the only definition that counts every session.** A session-distinct
  count discards the 2,849 unattributed rows, and those rows are real usage.
  (Measured 2026-09-29 over 4,458 rows; **5,369 of 7,908 rows** on the
  2026-09-30 measurement — on that corpus only 1,589 of the 6,666 canonical
  cycles carry a session id, so a session-distinct count discards the large
  majority of them.)
- **The cardinality measurement means nothing is lost by counting rows.** One
  session id is exactly one row, so `countIf(...)` and
  `countDistinct(machine_session_id)` would be identical over the attributed
  subset. The row count is a strict superset.
  (Cardinality measured 2026-09-29: 1,609 session ids, 0 spanning more than one
  row, 0 carrying more than one `status`. **Re-measured 2026-09-30
  12:20:17 / 12:41:59 UTC, by hand with `status` filtered by name, on the
  migrated and merged warehouse: 2,544 session ids with min = max = avg = 1
  rows per session, and 0 of 2,545 session ids carrying more than one `status`
  (max distinct statuses = 1). The 1:1 shape survives the enum migration and
  the merge. See the recovery record §5A.5; the script itself was not run or
  modified, because it refuses to run against a migrated column by design.)
- **It aligns the dashboard with the analytics layer.** `DAILY_SQL` already
  used `countIf(status IN ('finished','paid'))`. This removes a divergence
  rather than creating one.
- **The status filter is a data-contract decision and is untouched.**
  `docs/03_data_contracts/data_contracts.md` authorises the `paid` + `finished`
  pair for revenue and cycle counts. Revenue aggregation is **unchanged** — it is
  separately correct, separately tested, and separately verified. Only the
  spelling moved, from `IN (2, 4)` to `IN ('paid', 'finished')`, because the
  enum was renumbered to the IRIS lifecycle order.

> **The price band is not load-bearing for this decision.** The first three
> bullets stand on the cardinality measurement and the superset property, both
> of which are independent of any ฿/cycle arithmetic. The ฿/cycle band was the
> most intuitive support on 2026-09-29 (฿42.20) and it no longer supplies that
> support on 2026-09-30 (฿48.40, above the band) — see the re-measured band
> above. The decision is therefore **weaker than the 2026-09-29 record implies**,
> resting on the first two bullets plus the data-contract authorisation, not on
> price plausibility. The 1:1 cardinality shape behind bullet 2 was measured
> only on 2026-09-29, and has since been **re-measured on 2026-09-30
> 12:20/12:41 UTC and still holds** (recovery record §5A.5). So the two
> price-independent legs of the decision are intact, and the price leg is not
> merely absent but **explained away** — see the measurement above, which finds
> the band agreement is a by-product of attribution mix.

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
  event, one session id spans exactly one row, and 67.8933% of rows carry no
  session id at all (5,369 of 7,908, measured 2026-09-30 11:39:11 UTC; it was
  65.25% of 5,146 rows on 2026-09-29 and 63.91% of 4,458 rows earlier that day
  — see the live-metric note above; each is a point-in-time measurement, not a
  property of the data).
- `paid_ratio` was documented as a bare `Float64`. On real data it is
  **undefined, not zero**, when a branch-day has no `paid` and no `finished`
  row, and `paid` appeared on only 257 rows of which **6** carry a session id
  (measured 2026-09-29). The `paid` row count is **262** as of 2026-09-30
  11:39:11 UTC; the session-id subset of those rows was **not re-measured**, so
  the 6-of-257 figure stands as dated and unrefreshed. It is now
  `Nullable(Float64)` with `nullIf(..., 0)`.
- "~4.8k usage rows (~1 week)" was wrong in four places
  (`AGENTS.md`, `README.md`, `docs/06_ml/ml-training-data-guide.md`,
  `docs/06_ml/algorithm-comparison.md`). The warehouse held 4,458 non-synthetic
  rows over 9 weeks (measured 2026-09-29) and holds **7,908 rows over 71
  calendar days** (measured 2026-09-30 11:39:11 UTC, after the recovery merge).
  Still far too little for time-series modelling — 71 days is short of the
  90 days a Prophet/SARIMA/GBM candidate requires.
- `machine_session_id` had no entry in
  `docs/03_data_contracts/data_contracts.md` at all. It has one now, recording
  only what is evidenced: nullable, pass-through from IRIS, **absent on
  67.8933% of real rows** (5,369 of 7,908, measured 2026-09-30 11:39:11 UTC),
  corresponding to (but **not provably identical to**) the
  `attribution_state = 'pending_attribution'` set — 5,368 pending against 5,369
  NULL, so the two columns are independent; see the reconciliation note above,
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
