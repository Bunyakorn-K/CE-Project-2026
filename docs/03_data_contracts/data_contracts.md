# 📑 Data Contracts & Rules (Main Rules)

**Document Purpose:** This document defines the primary data contract rules, mandatory fields, validation logic, and execution scopes required across the telemetry pipeline, backend storage, and API layers.
**CRITICAL FOR AI AGENTS:** Always enforce these data rules strictly when generating database schemas, DTOs, data validation middleware, or API endpoints.

| Domain / Area | Field / Rule | Data Source | Definition & Control Requirements | Used By | Status / Milestone |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tenant Identity** | `branch_id` | Device provisioning / backend | Unique & immutable branch ID. **MUST** be present in every telemetry event and database query. Reject missing/unknown `branch_id` and strictly enforce server-side scope. | R01, R04, Dashboard, AI | **Required before MVP** |
| **Device Identity** | `machine_id` | Device provisioning | Unique machine ID within a branch (not just a UI display name). Reject duplicate mappings and log device mapping history. | Digital Twin, Alerts, Maintenance | **Required before MVP** |
| **Schema Version** | `register_map_version` | Device mapping registry | Version tag specifying register address, unit, type, bits, and valid value ranges for a machine model. Reject events referencing unknown map versions. | All register-based features | **Required before MVP** |
| **Event Timestamp** | `event_timestamp` | Device gateway / ingestion | UTC timestamp when telemetry was generated. Store `received_at` separately. Reject invalid timestamps and flag excessive clock skew. | Time series, KPI, Alerts | **Required before MVP** |
| **Machine State** | `state` | Mapped register (e.g., Reg 4) | Enum value for machine state defined explicitly in `register_map_version`. Do not guess state in the UI. Reject unknown enums and flag data quality status. | Digital Twin, Anomaly rules | **Required before MVP** |
| **Session Status** | `status` | IRIS session record, mirrored to `fact_machine_usage.status` | `Enum8('pending_payment' = 1, 'paid' = 2, 'admitted' = 3, 'running' = 4, 'finished' = 5, 'cancelled' = 6)` — numbered by the **IRIS lifecycle order**, decided 2026-09-29. All six members are known and each must surface as its own value. **Filter by NAME, never by number** (`status IN ('paid', 'finished')`): the numbers are a storage encoding that has already been renumbered once, and ClickHouse resolves a string literal against the enum by name, so names cannot drift. **`paid` and `finished` are provably distinct** (see below) and must not be collapsed, and neither may be labelled a payment receipt without evidence. Revenue and cycle counts legitimately include both; a KPI may not equate the two. | Dashboard, Digital Twin, `paid_ratio` (F-13) | **Numbering resolved 2026-09-29; `paid` vs `finished` proven distinct** |
| **Session Attribution** | `machine_session_id` | IRIS session record, mirrored to `fact_machine_usage.machine_session_id` | `Nullable(String)`, a pass-through copy of IRIS `attribution_machine_session_id` (`apps/etl/src/postgres.ts:141` → `apps/etl/src/transform.ts:194`). **Absent on 67.8933% of real rows** (5,369 of 7,908, measured 2026-09-30 11:39:11 UTC) and present on the rest; the absent set is essentially the `attribution_state = 'pending_attribution'` set. That share is a **live metric, not a constant** — it was 63.91% of 4,458 rows earlier on 2026-09-29 — so quote it only with its measurement date. Where present it is **one row per session, and one status per session** (measured on 4,458 non-synthetic rows, 2026-07-22 → 2026-09-25: 1,609 session ids, 0 spanning more than one row, 0 carrying more than one `status`; **not re-measured 2026-09-30**). **Its upstream meaning and its attribution semantics are UNRESOLVED** — do not infer a session boundary, a payment link, or a "verified" flag from it, and do not fabricate one where it is NULL. It is **not** used to count cycles: the canonical cycle count is the row count `countIf(status IN ('paid', 'finished'))`. It is used only to report how much of that count carries session-level evidence (`dashboard.cycleAttribution`), which stays `null` where the source cannot measure it. | Attribution reporting, `cycleAttribution` | **Cardinality measured 2026-09-29 (not re-measured 2026-09-30); NULL share measured 2026-09-30 11:39:11 UTC; semantics unresolved** |
| **Remaining Time** | `remaining_seconds` | Mapped registers (e.g., Reg 6, 7) | Normalized remaining time as a non-negative integer in seconds. Must define source units and handle counter rollovers properly. | Digital Twin, Public status | **Required before MVP** |
| **Temperature** | `temperature_c` | Mapped register (e.g., Reg 13) | Normalized Celsius value. Must handle unit conversion (from Fahrenheit) and validate against reasonable sensor boundaries. | Digital Twin, Gas estimate, Anomaly rules | **Required before MVP** |
| **Temperature Sample** | `fact_temperature_sample` | IRIS `machine_temperature_sample`, mirrored to ClickHouse | Plain `MergeTree` partitioned by month, ordered by `(tenant_id, branch_id, occurred_at, event_id)` (`apps/etl/src/schema.ts`). **NOT `ReplacingMergeTree` and NOT `FINAL`-able into a de-duplicated result: it has no de-duplication, so a re-read of an already-loaded window inserts permanent duplicate sort keys.** Measured 2026-09-30 11:39:11 UTC on the production warehouse: 3,760,465 rows over 2,256,545 distinct `(tenant_id, branch_id, occurred_at, event_id)` tuples — **1,503,920 duplicate sort keys**, predating the 2026-09-30 recovery merge and **not fixable in place**; clearing it requires a table rewrite (insert `row_number()`-collapsed rows into a new table and swap). Any `count()` over this table is a count of reads, not of distinct readings; aggregate on the distinct tuple, and note that `FINAL` does **not** help here because the engine is a plain `MergeTree`. Span 2026-05-26 15:51:50.633 → 2026-09-29 11:37:18.725, 126 distinct day buckets; **2026-06-17 is the only missing day** in that range, and it predates the warehouse's first usage row (2026-07-22) by 35 days. See `docs/04_traceability/ops-verification-2026-09-30-warehouse-data-recovery.md`. | Digital Twin, Gas estimate, Anomaly rules, Analytics temperature curve | **Duplicate excess measured 2026-09-30; rewrite required, not done** |
| **Payment / Revenue** | `paid_counter` or transaction event | Mapped register / payment source | Explicitly define whether value is lifetime accumulated, per-session, cash-only, or all payment methods. Record reset semantics and cross-check against transaction events. | KPI, Coin box estimate | **Required before MVP** |
| **Door Status** | `door_status` | Explicit mapped bit/register | Physical door status ONLY. **DO NOT** use as a proxy for coin box status without explicit documentation. Specify device type, address, and bit in `register_map_version`. | Digital Twin | **Required before MVP** |
| **Coin Box Open** | `coinbox_open` | Explicit mapped switch/event | Mapped event allowed to reset coin box volume estimates. If missing on hardware, require a manual reset with audit logging. **NEVER** infer from `door_status`. | Coin Box estimation | **Required before MVP** |
| **Gas Pressure** | `gas_pressure` | External gas pressure sensor | Pressure reading with units, sensor ID, and sampling window. Check reasonable value ranges and flag missing sensor data. | Gas early-warning | **Required before MVP** |
| **Gas Leak Detected** | `gas_leak_detected` | Dedicated gas-leak detector | Boolean signal from a dedicated physical gas leak sensor (separate from pressure drop estimation). Local alarm must function offline even if cloud disconnects. | Safety alert | *Hardware decision required* |
| **Alert Rules** | `rule_id` + `rule_version` | Alert configuration | Versioned configuration defining thresholds, cooldowns, recipients, and enabled states. Log every rule evaluation and dispatch outcome. | Notifications, Audit log | **Required before MVP** |
| **Weather Temp** | `weather_temp_c` | TMD NWP API (collector) | Normalized Celsius. Nullable — a missing reading stays NULL, never fabricated. `fact_weather_sample` (ReplacingMergeTree by `(tenant_id, branch_id, timestamp)` — the key since 2026-09-10, when collection became per registered branch; it was `(province, timestamp)` before that). | F-12 correlation | **Phase 2** |
| **Weather Sub-District** | `sub_district` | Branch config (ops) | Nullable Thai sub-district name. Reserved for future per-position weather data; currently `NULL` (no per-position source). | F-12 correlation | **Phase 2** |
| **Weather District** | `district` | Branch config (ops) | Nullable Thai district name. Reserved for future per-position weather data; currently `NULL`. | F-12 correlation | **Phase 2** |
| **Weather Humidity** | `weather_humidity_pct` | TMD NWP API | Relative humidity percent. Nullable. | F-12 correlation | **Phase 2** |
| **Weather Rain** | `weather_rain_mm` | TMD NWP API | Precipitation in mm. Nullable. | F-12 correlation | **Phase 2** |
| **Weather Condition** | `weather_cond` | TMD NWP API | TMD condition code (integer). Nullable; treat as opaque until TMD's code table is pinned in docs. | F-12 correlation | **Phase 2** |
| **Weather Source Auth** | `TMD_API_KEY` | TMD account | Bearer token from **env only** — never committed, never sent to the browser. Collector: `apps/etl/src/weather.ts` via `TMD_API_KEY`. | F-12 collector | **Phase 2** |
| **Weather Correlation Semantics** | — | F-12 output | Correlation only: output must state source range and explicitly deny causation/forecast claims (R12). | Weather analysis | **Phase 2** |
## `status` enum numbering — decision 2026-09-29

`fact_machine_usage.status` is renumbered to the real IRIS lifecycle order:

```text
pending_payment(1) -> paid(2) -> admitted(3) -> running(4) -> finished(5)
                                                     \-> cancelled(6)
```

The previous declaration was `pending_payment=1, paid=2, running=3, finished=4,
cancelled=5, admitted=6`, which put `admitted` — the first step of a running
cycle — *after* `cancelled`. Any range or ordering comparison over the column
was therefore wrong: `status >= 3` read "past the payment queue" while actually
selecting `running, finished, cancelled, admitted`.

### Evidence for the order

Read from the upstream repository (`Meepain-group/iris-project` @ `813ffa7`),
not inferred from the LaundryTwin data:

| Source | What it fixes |
|---|---|
| migration `0053:28-30` | constrains the lifecycle projector to `desired_status IN ('running','finished')` — `running` is reached *after* admission and payment |
| `active-machine-usage.ts:22-33` | counts `paid`/`running` as in-progress; `admitted`/`pending_payment` as occupancy-only — so `admitted` is between `paid` and `running` |
| `cron.ts:2202` | sweeps `pending_payment -> cancelled`, making `cancelled` reachable from the very first state |
| `0053:41-44` | `last_phase = 'IDLE'` is a hard CHECK for `finished` — `finished` is terminal |

`cancelled` is therefore a terminal branch off the same point as `finished`, not
a step after it, and takes the last value.

**IRIS's own written enums are stale in the opposite direction.**
`packages/contracts/src/sync.ts:55,64` and `docs/05-database-schema.md:246` list
only five values and omit `admitted`, while `ingest.ts:4577,4647,4668,4700,4723`
actively handles it. There is also **no DB CHECK** on `machine_usage.status`
upstream — it is plain `text NOT NULL` — so there is no upstream constraint to
appeal to. LaundryTwin is ahead of the IRIS docs here, and this table is where
the six values are actually pinned down.

### `paid` and `finished` are provably distinct

Previously recorded as "semantics unresolved". The upstream read resolves it:

- `active-machine-usage.ts:22` counts `paid` as **in-progress**, alongside
  `running` — so at that point in the source, `paid` has not reached `finished`.
- `finished` requires `last_phase = 'IDLE'` (migration `0053:41-44`), a state a
  running cycle only reaches at session end.
- **Nothing sweeps a `paid` row.** The only sweeper upstream is
  `pending_payment -> cancelled` (`cron.ts:2202`). A session that is paid and
  then never receives an edge session-end event stays `paid` forever.

So the two are genuinely different states, and `paid` is a *stall* state, not a
synonym for finished. Consequences:

- Counting revenue and cycles as `IN ('paid', 'finished')` is **sound** — it is
  the canonical cycle definition (see `docs/04_traceability/RTM_matrix.md`).
- `paid_ratio` **must not** equate them. A non-trivial `paid` share is evidence
  of sessions that never emitted a session-end event, i.e. a data-quality gap,
  not a revenue figure. `docs/06_ml/ml-training-data-guide.md` already defines
  it as `countIf(status='paid') / nullIf(countIf(status IN ('finished','paid')), 0)`.

### Caveat: `amount_satang` is not proof of settlement

`amount_satang` is the **pre-set program price** copied from the IRIS usage
row, not evidence that money was collected. Settlement truth lives in the
`payment` table, which this warehouse does not mirror. Revenue figures derived
from `amount_satang` are a program-price aggregate, and must be described that
way. This caveat is independent of the numbering change and is unchanged by it.

### Migration status

`apps/etl/src/schema.ts` declares the corrected numbering, but
`CREATE TABLE IF NOT EXISTS` never alters an existing table — that line governs
**new** tables only. Existing deployments are handled by
`apps/api/scripts/migrate-usage-status-enum.ts`, which **ran against production
on 2026-09-29**; the deployed column now matches the declaration above. Do not
re-run it: the script refuses an already-migrated column by design.

`ALTER TABLE ... MODIFY COLUMN status Enum8(...)` is **not** usable: it
reinterprets stored bytes rather than converting them, and on ClickHouse 26.3 it
is outright refused with `Code: 70 ... Enum conversion changes value for element
'running' from 3 to 4 (CANNOT_CONVERT_TYPE)`. The migration therefore rebuilds
the column: add the corrected column, backfill it by mapping every value by
name, verify the distribution, swap the names, drop the old column.

Three properties of that rebuild are not optional, and each was found by
running it rather than by reading it:

- **The pre-swap verification must read the backfilled column**, not the source
  one. Reading the source compares the untouched data against itself and passes
  for any backfill, including none.
- **The backfill's `WHERE` must not read the column it is writing.** `ADD COLUMN`
  without a `DEFAULT` materialises the type's implicit default for existing
  rows, and on a build that materialises the out-of-range value `0` the
  predicate itself raises `Code: 691 UNKNOWN_ELEMENT_OF_ENUM`. The `WHERE` is
  unconditional so the materialised value cannot matter.
- **The ETL must be held still for the window.** A mutation only rewrites the
  parts it snapshotted, so a row written afterwards keeps the pre-backfill value
  and the rename reclassifies it silently — reproduced end to end, where a
  `paid` row came out of the swap as `pending_payment`. Use
  `deploy/etl/hold-etl-for-warehouse-migration.sh`.

The `proj_by_time` projection (below) is `SELECT *`, so it holds its own copy of
`status` and must be dropped for the swap and rebuilt after it; while it is
attached the RENAME is refused with the same `Code: 70`.

**The production migration has not been run.** The script has only been executed
against local scratch tables. The deployment gate is still blocked.
