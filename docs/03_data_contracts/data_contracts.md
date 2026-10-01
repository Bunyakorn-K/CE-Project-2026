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
| **Session Attribution** | `machine_session_id` | IRIS session record, mirrored to `fact_machine_usage.machine_session_id` | `Nullable(String)`, a pass-through copy of IRIS `attribution_machine_session_id` (`apps/etl/src/postgres.ts:141` → `apps/etl/src/transform.ts:194`). **Absent on the majority of real rows** (currently ~68%; the exact share is a live metric — it rises as the ETL ingests the IRIS backlog, because backlog rows predate session attribution — so quote it only with its measurement date, from `docs/06_ml/ml-training-data-guide.md` §9.1) and present on the rest; the absent set is essentially the `attribution_state = 'pending_attribution'` set. Where present it is **one row per session, and one status per session** (measured on 4,458 non-synthetic rows, 2026-07-22 → 2026-09-25: 1,609 session ids, 0 spanning more than one row, 0 carrying more than one `status`; **not re-measured after the 2026-09-30 recovery merge**). **Its upstream meaning and its attribution semantics are UNRESOLVED** — do not infer a session boundary, a payment link, or a "verified" flag from it, and do not fabricate one where it is NULL. It is **not** used to count cycles: the canonical cycle count is the row count `countIf(status IN ('paid', 'finished'))`. It is used only to report how much of that count carries session-level evidence (`dashboard.cycleAttribution`), which stays `null` where the source cannot measure it. | Attribution reporting, `cycleAttribution` | **Cardinality measured 2026-09-29 (not re-measured 2026-09-30); NULL share measured 2026-09-30 11:39:11 UTC; semantics unresolved** |
| **Remaining Time** | `remaining_seconds` | Mapped registers (e.g., Reg 6, 7) | Normalized remaining time as a non-negative integer in seconds. Must define source units and handle counter rollovers properly. | Digital Twin, Public status | **Required before MVP** |
| **Temperature** | `temperature_c` | Mapped register (e.g., Reg 13) | Normalized Celsius value. Must handle unit conversion (from Fahrenheit) and validate against reasonable sensor boundaries. | Digital Twin, Gas estimate, Anomaly rules | **Required before MVP** |
| **Temperature Sample** | `fact_temperature_sample` | IRIS `machine_temperature_sample`, mirrored to ClickHouse | `ReplacingMergeTree(extracted_at)` partitioned by month, ordered by `(tenant_id, branch_id, occurred_at, event_id)` (`apps/etl/src/schema.ts`). **Migrated 2026-09-30 from a plain `MergeTree`.** The plain engine gave the pipeline no de-duplication at all — the ETL inserts a batch and only then advances the watermark, so a run that died in between re-inserted everything from the old cursor on the next cycle. That was not theoretical: **1,503,920 duplicate sort keys** accumulated, and the worst single sample was written **82 times across 82 distinct `extracted_at` values** spread over 6h49m — the number of 5-minute ETL cycles in that window. Root cause ruled out by measurement, not assumption: the IRIS join is 1:1 for every source row, `event_id` is unique in the source, and no `(occurred_at, seq)` tie exists, so the duplication was the ETL re-reading its own tail. Every copy of a key was byte-identical except `extracted_at`, so collapsing was **lossless**: 3,762,139 rows → **2,258,219** distinct keys, 0 content mismatches, 126 day buckets before and after. Span and history are intact, including the ~2 months the warehouse holds that IRIS no longer does (warehouse from 2026-05-26; the source table now starts 2026-07-01) — **so this could not have been fixed by re-loading from IRIS, which would have deleted that history.** `FINAL` is now both valid and required: the analytics curve query reads `fact_temperature_sample AS s FINAL`, and the engine change is what made that possible — against the old table ClickHouse refuses it with `Code: 181 ... Storage MergeTree doesn't support FINAL (ILLEGAL_FINAL)`. Measured 2026-09-30 on 2026-09-22..26, the undeduplicated query returned 35,486 rows for 34,169 distinct readings, drawing **1,317 readings twice** and inflating the rows-in-range figure in `meta.truncation`; the shipped query returns 34,169 with 0 duplicates. The pre-migration table is retained as `fact_temperature_sample_pre_dedup` (3,762,139 rows) as the rollback target — see `docs/04_traceability/ops-verification-2026-09-30-temperature-dedup-migration.md`. | Digital Twin, Gas estimate, Anomaly rules, Analytics temperature curve | **Migrated 2026-09-30; 1,503,920 duplicates collapsed, lossless** |
| **Payment / Revenue** | `paid_counter` or transaction event | Mapped register / payment source | Explicitly define whether value is lifetime accumulated, per-session, cash-only, or all payment methods. Record reset semantics and cross-check against transaction events. | KPI, Coin box estimate | **Required before MVP** |
| **Door Status** | `door_status` | Explicit mapped bit/register | Physical door status ONLY. **DO NOT** use as a proxy for coin box status without explicit documentation. Specify device type, address, and bit in `register_map_version`. | Digital Twin | **Required before MVP** |
| **Coin Box Open** | `coinbox_open` | Explicit mapped switch/event | Mapped event allowed to reset coin box volume estimates. If missing on hardware, require a manual reset with audit logging. **NEVER** infer from `door_status`. | Coin Box estimation | **Required before MVP** |
| **Gas Pressure** | `gas_pressure` | External gas pressure sensor | Pressure reading with units, sensor ID, and sampling window. Check reasonable value ranges and flag missing sensor data. A non-IRIS source has been located and measured for `otterimju2` — see `docs/03_data_contracts/ha_gas_sensor_contract.md` for its fields, its 7-day retention ceiling, and its safety boundary. A collector for the three pressure channels exists in code with local test evidence (`fact_gas_pressure_sample`, `apps/etl/src/gas.ts`) but is **not deployed**; `unavailable` is stored as NULL, never 0. Pressure is still not a leak detector — `gas_leak_detected` below is a separate, unbuilt field. | Gas early-warning | **Required before MVP** |
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

**The production migration HAS been run** (2026-09-29, via
`apps/api/scripts/migrate-usage-status-enum.ts --apply`); `DESCRIBE TABLE
fact_machine_usage` now matches `apps/etl/src/schema.ts`, and the script
refuses an already-migrated column by design. See `AGENTS.md` for the deploy
record.

## Machine `cycleCount` — three states, decision 2026-10-01

`GET /api/twin` reports a per-machine cycle count. **A count of zero and an
unavailable count are different facts**, and the contract previously could not
tell them apart.

### What was wrong

The machine-state query computed `cycle_count` as
`countIf(status IN ('paid', 'finished'))` and then collapsed a non-positive
result to `null`:

```text
cycleCount        = countedCycles > 0 ? countedCycles : null
cycleCountSource  = cycleCount === null ? "unavailable" : "usage_row"
```

But a usage row in `pending_payment`, `admitted`, or `cancelled` is **usage
without being a counted cycle**. A machine with seven such rows and no paid or
finished ones produced `countedCycles = 0` → `null` → `"unavailable"`, and the
Digital Twin card rendered that as *"ไม่มีแถว usage"* — **"no usage rows"**. The
API had never made that claim. A technician investigating a busy machine was
told to stop looking, and one demonstrably wrong provenance label discredits
every other label on the same card.

### The contract now

The query selects the denominator separately, so the API — not the view —
decides which of the three answers is true:

```sql
countIf(u.status IN ('paid', 'finished')) AS cycle_count,
countIf(u.status IS NOT NULL)             AS usage_rows
```

`countIf(u.status IS NOT NULL)` rather than `count()`, because
`SETTINGS join_use_nulls = 1` makes the unmatched LEFT JOIN row NULL; a plain
`count()` would count that placeholder as a usage row.

| `usage_rows` | `cycleCount` | `cycleCountSource` | Meaning |
|---|---|---|---|
| `> 0` | the counted number, **including `0`** | `"usage_row"` | The machine has usage rows in the window. Zero means none reached a counted state — a real, reportable answer. |
| `0` | `null` | `"unavailable"` | The source reported a row count and it was zero: no usage rows in the window. |
| absent | `null` | `"unavailable"` | The response carries no row count (pre-migration shape). An unknown denominator must not become a usage-row claim. |

`GET /api/twin` in **demo/IRIS mode** reports `cycleCountSource: "unknown"` and
`cycleCount: null`. That projection has no usage-row field at all, so it cannot
say whether a machine was used — a different claim from "no usage rows", and
the interface renders it differently (`apps/web/src/lib/machine-facts.ts`).

### Verified

Executed against a real ClickHouse 26.3 engine on a fixture built to the
production schema (`Enum8` status, `ReplacingMergeTree`, `join_use_nulls = 1`),
with the shipped SQL unmodified except for the literal date parameters:

| machine | usage rows | counted cycles | expected |
|---|---|---|---|
| W1 | 5 | 2 | `cycleCount: 2`, `usage_row` |
| **W2** | **7** | **0** | **`cycleCount: 0`, `usage_row`** — the regression case |
| W3 | 0 | 0 | `cycleCount: null`, `unavailable` |
| W4 | 0 (rows outside window only) | 0 | `cycleCount: null`, `unavailable` |

## Machine `freshness` — a separate axis from `status`, 2026-10-01

`GET /api/twin` now carries `freshness` and `freshnessReason` per machine.
`status` describes **what the last usage row claimed**; `freshness` describes
**how much a reader should trust that as a statement about now**. They are not
interchangeable: a branch whose machines stopped reporting six days ago still
yielded a confident `running` pill, a running drum animation, and a
`ใช้งานล่าสุด` line with nothing marking it as describing the past.

| Value | Condition | Reason string |
|---|---|---|
| `fresh` | newest usage evidence ≤ 5 minutes | `null` |
| `stale` | ≤ 30 minutes | `Usage data is older than 30 minutes` |
| `unavailable` | older than 30 minutes, absent, unparseable, **or in the future** | `No recent usage evidence is available for this machine` |

A future timestamp is `unavailable`, not `fresh` — a clock skew must not read as
a live machine.

The thresholds live once, in `usageFreshnessOf()`
(`apps/api/src/report/clickhouse-report.ts`). `GET /api/report/live` previously
kept a private copy of the same thresholds in `apps/api/src/index.ts`; it now
consumes the value computed by `queryMachineStates`, so the twin and the live
snapshot cannot disagree about the same machine. The Thai labels are the ones
already shipped in `apps/web/src/lib/machine-status.ts`.

`freshnessReason` is **English and machine-readable on purpose**: it is a
contract field, and the web layer maps it to Thai by keying on `freshness`,
never by matching that prose — see `apps/web/src/lib/alerts-view.ts` for the
same rule and the reason it exists.

## Branch `branchOpenState` — a third axis, 2026-10-01

Measured on production 2026-10-01 at roughly 22:15 local: the newest usage row
at the real branch was **52 minutes old**, so all **19 of 19** machines read
`freshness: "unavailable"` and rendered `ไม่พร้อมใช้งาน` in `--danger` red.
Nothing was broken. No usage rows arrive while a laundromat is closed, and the
branch was shut. One data fact — no recent usage — was asserting three things
it cannot support: no evidence, machine unusable, and something is wrong.

| Value | Condition |
|---|---|
| `open` | the branch's provisioned hours say it is trading, in its own timezone |
| `closed` | the schedule **positively** says it is shut |
| `unknown` | no schedule provisioned, an unusable timezone, or the hours could not be read |

### The safety rule

**`closed` means "the branch is shut, so machine state is not observable". It
NEVER means "assume the machines are fine".**

Two consequences are enforced in code and by test, not left to reviewers:

1. An unknown or malformed schedule resolves to `unknown`, and `unknown`
   passes `freshness` through **unchanged**. An absent schedule defaulted to
   `closed` would mean one unpopulated row silently suppresses a genuine
   machine fault across an entire branch — the alarm would stop working exactly
   when it was needed. This is also why the web treats an **absent**
   `branchOpenState` as `unknown`: it is what an API build predating this
   feature sends, and assuming `closed` client-side would silence the warning
   for any account talking to an older server.
2. A machine with no evidence while the branch is **open** stays
   `unavailable` — red, technician-warranted. That is the case `closed` must
   never swallow.

So the mechanism can only ever make the alarm quieter when the schedule
positively says the branch is shut, and never otherwise.

### Why it is a separate field and not a fourth `freshness` value

`freshness` is a per-machine evidence age that `apps/api/src/reporting.ts`
tallies into the AI context (`unavailable` and `stale` counts). Widening that
union would make a closed branch's machines **vanish** from the tally instead
of being counted as unobservable. Two axes, two fields; the web combines them
in `machineAvailability` (`apps/web/src/lib/branch-availability-view.ts`), which
holds the same rule so an older API cannot undo it.

### `dim_branch_hours` — provisioned by ops, never by the ETL

`open_minute`/`close_minute` are minutes from local midnight; `close_minute` is
**exclusive**, so a branch closing at 22:00 is already closed at 22:00. A
`close_minute < open_minute` window wraps and means "trades past midnight"
(22:00–02:00). `open_days` is an ISO weekday array (1 = Monday … 7 = Sunday)
and **empty means every day**, so a 7-day branch needs no enumeration.

The table is declared in `apps/etl/src/schema.ts` so the DDL pass creates it,
but the ETL **must never write it**: it re-syncs every other dim on each
5-minute cycle and would clobber an operator's hours within one run. A test
asserts no insert ever targets it.

### What production is provisioned with (2026-10-01)

Provisioned on VM 117 for the real branch only, as `open_minute=0`,
`close_minute=1440`, `open_days=[]`, `version=1` — i.e. **trades 24 hours,
every day**, because that is what the usage data shows and not a guess:

- All 24 hours and all 7 ISO weekdays carry usage across the 71-day history.
  No hour and no weekday is ever empty.
- Every overnight row belongs to the real branch. At 00:00 there are 123 rows
  across 39 distinct days, and at 04:00 there are 19 rows across 15 days. A
  staffed shop does not trade at 04:00 on 15 separate days; a coin-op
  self-service laundromat does.
- Overnight is genuinely quieter — 19–63 rows for 02:00–07:00 against 355–663
  for the 09:00–20:00 peak — but **quieter is not closed**, and a threshold
  that reads "no usage" as "shut" is exactly the mistake this axis exists to
  prevent.

The SANDBOX branch (`e9b98f78-…`) is deliberately **not** provisioned. Its
name states it is not a real branch and it holds zero usage rows, so any hours
written for it would be a fabricated business fact.

**A consequence worth stating plainly: with a 24/7 schedule, `branchOpenState`
resolves to `open` for this branch at every minute, so no machine pill changes
appearance today.** That is the correct outcome, not a failed fix — the
measurements show the branch really was trading when 19 machines read
`unavailable` at ~22:15, so the red `ไม่พร้อมใช้งาน` pills were reporting a real
absence of evidence and suppressing them would have been wrong. Verified after
provisioning: the row returns `open` and `effectiveAvailability("unavailable",
"open")` stays `unavailable` at every probe.

What this fixes is the **honesty of the axis**: `unknown` becomes a positive,
evidence-backed `open`, so a future branch that genuinely closes will be
represented rather than guessed at.

### Failure handling

`queryBranchHours` is a **separate, independently fault-tolerant** query, not a
JOIN. `dim_branch_hours` does not exist on every warehouse, and a JOIN against a
missing table fails the whole machine query with `Code: 60 UNKNOWN_TABLE` —
turning an optional refinement into an outage of the page that reports broken
machines. Every failure mode (absent table, permission error, non-array answer,
malformed row) resolves to `unknown`. A malformed row is dropped rather than
coerced: an operator typo must degrade that branch, not produce a confidently
wrong schedule.

`version` mirrors `dim_branch_location` — an integer revision counter, bumped
by ops on re-provision. A String version column makes the CREATE fail with
`Code 169 BAD_TYPE_OF_FIELD`, which aborts `runEtl` before any fact table exists.
