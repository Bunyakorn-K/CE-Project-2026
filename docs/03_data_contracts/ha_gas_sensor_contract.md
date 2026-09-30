# ⛽ Home Assistant Gas / Pressure Sensor Contract (otterimju2)

**Document Purpose:** This document records a **newly located, third-party telemetry
source** for LPG tank pressure at the `otterimju2` branch: Home Assistant MQTT
sensors backed by a MySQL recorder store. It defines the available fields, their
units, the measurement evidence, and — equally important — what each field
**does not** mean.

**Status: deployed and ingesting (2026-09-30).** The three pressure channels —
`gas_pressure_a`, `gas_pressure_b` and `changeover_pressure` — are loaded
hourly by `laundrytwin-gas-1` on VM 117 into
`laundrytwin_analytics.fact_gas_pressure_sample` (`apps/etl/src/gas.ts`,
`apps/etl/src/gas-run.ts`, `apps/etl/src/schema.ts`). The first production pass
read 884 rows over a 3-hour window with zero coerced zeros and no
`gas_detector` entity present; production evidence and rollback steps are in
`docs/04_traceability/ops-verification-2026-09-30-gas-collector-deploy.md`.
There is still **no API surface** and **no alert** for this source, and none is
proposed here.

The remaining fields in this document (`gas_rate_*`, `gas_energy_total`,
`tank_change_*_monthly`) and the `gas_detector_*` heartbeat entities are
**contract only** and are deliberately not ingested. See "Ingestion scope".

**CRITICAL FOR AI AGENTS:** This is **not** a life-safety system and **not** a
leak detector. Read "Safety boundary" before using any number in this document.
Do not derive a gas-leak conclusion from any field here. Do not restate a
pressure trend as a safety finding, an alarm, or a leak.

---

## 🚨 Safety boundary

This section is binding and outranks any inference a downstream reader might
draw from the tables.

1. **Tank pressure is not a leak detector.** A stable or falling psi reading
   does **not** detect a leak. A falling reading has multiple benign
   explanations — normal consumption, ambient temperature change, regulator
   behaviour, and sensor dropout. `data_contracts.md` keeps
   `gas_leak_detected` as a **separate** field sourced from a dedicated physical
   detector, and that separation is unchanged by this document.
2. **Pressure trends may support a low-gas estimate only when evaluated together
   with machine state and temperature.** This mirrors the `AGENTS.md` rule
   verbatim: *"Pressure trends may support a low-gas estimate when evaluated
   with machine state and temperature. Do not claim that pressure alone detects
   a gas leak."* Any future low-gas inference from this source **must** combine
   `gas_pressure` with dryer `state` and `temperature_c` (R06 dependencies). A
   pressure-only rule does not satisfy R06 even once the field is available.
3. **This is not a life-safety system.** Dedicated local gas detection and
   alarms are explicitly outside the current software-only scope. Never present
   a cloud-derived estimate as a substitute for on-site detection.
4. **Provenance differs from IRIS.** This is branch-scoped operational telemetry
   from a third-party automation system, **not** an IRIS register. IRIS remains
   the system of record for usage and payment; this source is **additive** and
   **does not override** it. A conflict between the two is not evidence that
   either is wrong.
5. **No hardware change is proposed.** This contract proposes no new sensor, no
   rewiring, and no modification to the branch installation. The two candidates
   noted as "unresolved" below are *investigations to be authorised*, not
   proposals.

### What this document does **not** unblock

R06 (early low gas warning) was blocked because **no verified `gas_pressure`
register exists in the current IRIS contract**. This source is a genuinely
different and, by measurement, a real psi source for tanks A and B.

**It does not unblock R06.** R06 additionally requires the *trend evaluation*
logic — threshold selection, the machine-state and temperature join, alert
wiring, idempotency, and the `line` channel — none of which exists. What is
resolved here is **one input field's existence and unit**. Everything downstream
of ingestion remains unbuilt, and the 7-day retention ceiling below would cap any
trend logic even if it were built.

**R07 (coin box) is untouched by this document.** R07 is blocked for its own,
separate reason — unresolved `paid` / coin-box semantics and no explicitly
mapped `coinbox_open` event. Do not conflate the two blockers, and do not let
R06 progress be read as R07 progress.

---

## 🔗 Topology

```text
MQTT sensors (branch LAN)
  -> Home Assistant  (docker container homeassistant-minipc
                      host aboutyou-wash-dry-2 / aboutyou-minipc, 192.168.1.198)
  -> MySQL  database "homeassistant", 127.0.0.1:3306
       (HA recorder.db_url = mysql://assistantman:…@127.0.0.1:3306/homeassistant)
```

This path is **on a different network from the IRIS path** and shares no
component, credential, or database with it. There is no join key between the two
sources today, and none is proposed by this document.

---

## 🪤 Storage trap — read MySQL, not the container's SQLite

**The SQLite file inside the Home Assistant container is stale and must not be
read as evidence.**

| Store | Path | State |
| :--- | :--- | :--- |
| SQLite (inside container) | `/config/home-assistant_v2.db`, ~163 MB | **Stale.** History stops at **2026-07-17** and it contains **zero rows for every gas entity** in this document. |
| **MySQL (live)** | `homeassistant` on `127.0.0.1:3306`, user `assistantman` | **Live store.** Configured via `recorder.db_url`. All figures in this document come from here. |

**Consequence:** anyone who opens the SQLite file will correctly observe that
the gas sensors "have no history" and will draw the wrong conclusion. They do
have history; it is in MySQL. This trap is recorded here precisely so a later
session does not repeat the false negative.

**Credentials are deliberately not written down in this document.** The
connection string above shows the shape only. The `assistantman` password lives
in the HA configuration on that host and must never be committed, printed, or
copied into this repository.

**Retention:** `recorder.purge_keep_days: 7` with `auto_purge: true`. See
"Retention ceiling" below — this is the single most consequential property of
this source.

---

## 📇 Entity and attribute provenance

All entities below are `platform = mqtt` and none is disabled, read from
`core.entity_registry` on 2026-09-30.

| Entity | Unit | Attribute evidence | What it is |
| :--- | :--- | :--- | :--- |
| `sensor.otterimju2_gas_pressure_a` | `psi` | `unit_of_measurement: psi`, `device_class: gas`, `state_class: measurement` | Tank **A** pressure |
| `sensor.otterimju2_gas_pressure_b` | `psi` | same | Tank **B** pressure |
| `sensor.otterimju2_gas_rate_a` | *(none declared)* | — | Tank **A** rate; **unit unverified** |
| `sensor.otterimju2_gas_rate_b` | *(none declared)* | — | Tank **B** rate; **unit unverified** |
| `sensor.otterimju2_changeover_pressure` | `psi` | — | Gas **FILTER** pressure — *see the naming collision below* |
| `sensor.otterimju2_gas_energy_total` | *(none declared)* | — | Cumulative energy total; **unit and counter semantics unverified** |
| `counter.otterimju2_tank_change_a_monthly` | `count` | — | Monthly tank-A change counter |
| `counter.otterimju2_tank_change_b_monthly` | `count` | — | Monthly tank-B change counter |

`device_class: gas` and `state_class: measurement` are **Home Assistant
attributes, not LaundryTwin register-map evidence.** They establish the unit as
declared by the third-party system. They do not constitute an IRIS
`register_map_version`, and nothing here should be written into one.

---

## 📊 Field definitions, measured values, and their limits

**Every figure in this table was measured on 2026-09-30** against the MySQL
store. These are point-in-time measurements, not properties of the data, and
they move as the window rolls — quote them only with this date, the same rule
the RTM applies to the unattributed share.

| Field | Unit | Rows | Window (2026-09-30) | Avg | Min | Max | Stale at measure |
| :--- | :--- | ---: | :--- | ---: | ---: | ---: | ---: |
| `gas_pressure_a` | psi | 5,178 | 09-22 14:36 → 09-30 04:33 | 64.64 | **9** | 154 | 3 min |
| `gas_pressure_b` | psi | 19,738 | 09-22 14:12 → 09-30 04:36 | 87.73 | **9** | 141 | 0 min |
| `changeover_pressure` (gas **filter**) | psi | 25,651 | 09-22 14:13 → 09-30 04:36 | 22.01 | **9** | 25 | 0 min |
| `gas_rate_a` | **unverified** | 5,073 | 09-22 14:36 → 09-30 04:33 | −0.05 | −2.06 | 24.52 | 3 min |
| `gas_rate_b` | **unverified** | 19,432 | 09-22 14:12 → 09-30 04:36 | −0.01 | −3.57 | 23.20 | 0 min |
| `gas_energy_total` | **unverified** | 144 | 09-22 18:15 → 09-30 04:31 | 2849.21 | 0 | 3236.20 | — |
| `tank_change_a_monthly` | count | **1** | 2026-09-26 only | — | 6 | 6 | — |
| `tank_change_b_monthly` | count | **3** | 09-23 → 09-28 | — | 5 | 7 | — |

The "Stale at measure" column is the gap between the entity's last recorded row
and the moment of measurement. **A stale pressure reading is `unknown`, not
"pressure held steady since."**

> **Correction (2026-09-30, found by replaying the export through the
> collector).** The three Avg figures above were originally 64.41 / 87.65 /
> 21.99. Those are the averages **with the 18 `unavailable` rows per entity
> coerced to 0 psi** — the same coercion Rule 1 forbids. The Min column had
> already been corrected to 9, but the Avg column still carried it. Corrected
> values exclude the unavailable rows: **64.64 / 87.73 / 22.01** (over
> 5,160 / 19,720 / 25,633 numeric rows respectively).
>
> The two sets of numbers are close, which is exactly why this is worth
> stating rather than quietly editing: the error is invisible in the average
> and obvious in the minimum. An average that includes "no reading" as "no
> pressure" biases every mean downward, and a 3-row correction will never look
> alarming enough to be caught by a reader. The row counts, Min and Max were
> correct throughout and are unchanged.

### What each field does and does not mean

| Field | It DOES mean | It does **NOT** mean |
| :--- | :--- | :--- |
| `gas_pressure_a` / `gas_pressure_b` | The psi value the third-party system reported for LPG tank A / B at `recorded_at`. The only verified psi quantities in this document. | Not a leak reading. Not a regulator-health reading. **Not a "how full is the tank" percentage** — no tank geometry, capacity, or fill mapping has been verified, so a psi value **cannot** be converted to a remaining-gas figure. |
| `gas_rate_a` / `gas_rate_b` | Some rate the third-party system derives from tank A / B. | **Unit is unverified.** No `unit_of_measurement` is declared. Do not read it as psi/second, percent/minute, or any other unit until it is established. Do not use it to build a consumption model. |
| `changeover_pressure` | The **gas filter** manifold pressure. Steady ~22 psi across the window. | **NOT tank changeover pressure.** See the naming collision below. |
| `gas_energy_total` | A cumulative total reported by the third-party system. | **Only 144 rows** over the window — insufficient on its own for consumption-rate modelling. Its unit, whether it resets, and what "energy" means here are all unverified. |
| `tank_change_*_monthly` | A monthly change counter: **1** row for A, **3** for B (values 5 → 6 → 7, all in September). This is the entity that represents actual tank changeover. | Not a timestamped change event log. With 1 and 3 rows, it cannot support a change *rate*, a refill schedule, or a lead time. Do not infer one. |

---

## ⚠️ Naming collision: `changeover_pressure` is NOT changeover pressure

This is the most dangerous label in the source and is called out separately so
it cannot be inherited silently by a later reader.

- The entity is named `sensor.otterimju2_changeover_pressure`.
- Its `friendly_name` is **"ระบบแก๊ส ร้าน 2 แรงดันแก๊ส Filter"** — the word
  **Filter** is in the name published by the system itself.
- Its measured behaviour matches a filter manifold: steady ~22 psi average, max
  25, over 25,651 rows.

**Actual tank changeover** is represented by the `tank_change_*_monthly`
counters — a **different quantity** with 1 and 3 rows respectively.

Anyone who reads the entity name, skips the `friendly_name`, and models
"changeover pressure" as a tank-switchover signal will build on the wrong field.
The `friendly_name` is the evidence; the entity id is the misnomer.

---

## 🕳️ Data quality rules

### Rule 1 — `unavailable` is a system event, never a valid low reading

**Correction (2026-09-30, verified against the export):** the `0` values that a
first pass of this table appeared to show are **not numeric zeros**. They are the
Home Assistant sentinel state **`unavailable`**, which the export carries as the
literal string `unavailable` in the `state` column. The **true numeric minimum
on all three pressure entities is 9 psi.**

| Entity | `unavailable` rows | True numeric min |
| :--- | ---: | ---: |
| `gas_pressure_a` | 18 | **9 psi** |
| `gas_pressure_b` | 18 | **9 psi** |
| `changeover_pressure` | 18 | **9 psi** |
| `gas_energy_total` | 17 | 0 (unit unverified) |
| `gas_rate_a` | 115 | −2.06 |
| `gas_rate_b` | 1,037 | −3.57 |

Any figure that casts `unavailable` to a number and reports a minimum of `0` is
an artefact of that cast. **The tank sensors have never been observed to read
zero psi in this window.**

**These `unavailable` rows must be preserved as `unknown`, never coerced to a
number.** Coercing them to `0` would fabricate a reading of an empty tank, which
is both unsupported and unsafe in this domain.

**Evidence that the `unavailable` events are a shared system event, measured
2026-09-30:**

- **All three pressure entities go `unavailable` within the same millisecond,
  every time.** The 18 events are at matched timestamps offset by only tens of
  microseconds — e.g. `2026-09-23 14:00:51.766366` (B), `.766379` (A),
  `.766432` (filter), and `2026-09-29 15:11:35.990649` / `.990663` / `.990720`.
  Three independent physical measurements do not stop reporting simultaneously.
  A **shared** acquisition or broker event is the reading the data supports.
- The events **recur at two near-daily time-of-day clusters** — `14:00:49`–`14:00:51`
  and `15:11:13`–`15:12:05` local — plus one `18:17:42` event, across
  2026-09-22 → 09-29. The pattern is periodic, which is characteristic of a
  system event rather than of tank contents.
- Each pressure entity has **exactly 18** such rows, and the three entities' event
  timestamps are **one-to-one matched** — A, B, and the filter each drop out 18
  times and never independently.

**The synchrony establishes that the dropouts are shared and not per-tank
physical. It does not identify the cause.** Two candidate readings exist — a
recurring scheduled action, and a shared acquisition/broker event — and
**neither is established.** In particular, the near-daily clustering sits close
in time to `timer.otterimju2_change_over_timer` and
`automation.otterimju2_ykelik_force_gas_changeover_10_v2`, both present in the
registry. **That proximity is recorded as a lead for an authorised
investigation, not as a cause.** Do not restate it as a finding.

**Enforcement:** a pressure row whose `state` is `unavailable` is written as
`NULL` / `unknown` with a `data_quality` reason, never as `0` psi. Downstream
sums, averages, and trend rules must exclude it rather than average it in. This
follows the standing `AGENTS.md` rule to *"Preserve missing, stale, offline, and
unknown states; do not fabricate data."*

### Rule 2 — the A/B asymmetry is an open question, not a scaling factor

Tank A recorded **5,178** rows to tank B's **19,738** (≈3.8×), and A was **3
minutes stale** against B's 0 at measurement.

**The cause is UNDETERMINED.** Candidate hypotheses, none selected: publish-rate
gating under load, a QoS or topic difference between the two sensors, hardware
difference, or a configuration difference on the third-party side.

What the data adds — and it argues *against* the tidy explanation:

| Day (full days only) | A rows | B rows | A/B |
| :--- | ---: | ---: | ---: |
| 2026-09-23 | 842 | 2,614 | 0.322 |
| 2026-09-24 | 588 | 2,451 | 0.240 |
| 2026-09-25 | 704 | 2,268 | 0.310 |
| 2026-09-26 | 351 | 3,197 | 0.110 |
| 2026-09-27 | 197 | 2,979 | 0.066 |
| 2026-09-28 | 1,154 | 2,502 | 0.461 |
| 2026-09-29 | 885 | 2,128 | 0.416 |

The daily ratio spans **0.066 to 0.461 — a ~7× spread**. It is therefore **not a
fixed sampling-rate difference**, and **A cannot be reconstructed, interpolated,
or back-filled from B.** (2026-09-22 and 2026-09-30 are excluded from this table
because both are partial days: the window starts at 14:12 and the measurement
was taken at 04:36.)

Any rate, average, or trend computed over tank A alone carries this gap as
**unquantified sampling error**, and must say so. A three-minute-stale reading
is `unknown`, not a held value.

### Rule 3 — the 7-day retention ceiling

`recorder.purge_keep_days: 7` with `auto_purge: true`. **The 2026-09-22 start
date on every entity is an artefact of this window, not the sensors' history.**
The sensors have been reporting longer; the store does not keep it.

- **Any trend analysis over this source is capped at ~7 days** until retention
  changes. A 7-day window is shorter than the 90 days the ML guide requires for
  Prophet/SARIMA/GBM, so **no model candidate is admissible from this source
  today.**
- **Extending retention is a production configuration change on a live third-party
  system and requires explicit user approval.** It is recorded here as a
  prerequisite, not performed. It was not performed.
- Note the consequence of the ceiling for the A/B asymmetry: because the window
  rolls, the measured ratios above are the only record of that gap. They are
  already stale and will be unrecoverable.

---

## 🔴 The `gas_detector_*` entities are a heartbeat, not a detector

**Measured 2026-09-30. This closes what was previously the highest-risk unknown
in this document, and the answer is negative: there is no leak-detection signal
here at all.**

The entity ids `binary_sensor.otterimju2_gas_detector_a` / `_b` and their
`friendly_name` — **"สถานะอุ่นแก๊สระบบเดิม A"**, literally *"gas **warming** status,
legacy system, A"* — suggest gas detection. The behaviour does not.

| Evidence | Measurement |
| :--- | :--- |
| State distribution, A | 22,199 `on` / 22,193 `off` / 18 `unavailable` — **≈50/50** |
| State distribution, B | 24,383 `on` / 24,378 `off` / 18 `unavailable` — **≈50/50** |
| `on` share **per day**, A, 2026-09-22 → 09-30 | 50.00, 50.01, 50.02, 50.01, 50.01, 50.01, 49.97, 50.00, 50.03 |
| Observed toggle interval, A | `on` → `off` → `on` roughly every **5–25 seconds**, continuously, day and night |
| `attributes_id` | single value (272) for every row — no payload variation at all |
| `unavailable` rows | **18 each**, matching the pressure entities' 18 exactly |

**A 50.00–50.03% daily split with a fixed toggle cadence and a constant
attribute set is the signature of a liveness heartbeat, not a sensor.** A real
leak detector would be overwhelmingly `off` and would latch `on` during an
event; it would not alternate 22,000 times a day while the shop is quiet, on a
branch that is operating normally.

The exact 50/50 ratio, the day-long constancy, and the fact that the 18
`unavailable` rows match the pressure entities' 18 one-for-one all point the
same way: these entities report that the *gas system's legacy controller is
alive and toggling*, and nothing more.

**Consequences, and they matter:**

- **This source contains no leak-detection data.** The only field in this
  document that could ever have spoken to leak detection does not. `gas_leak_detected`
  in `data_contracts.md` remains **unimplemented and unsourced**, exactly as
  before — this document does not move it.
- **Never ingest or alert on these entities as leak detection.** Doing so would
  manufacture a 50%-of-the-time "leak" reading and could page an operator for a
  normal, healthy system.
- The only useful thing they carry is **liveness** of the legacy gas
  controller, which is legitimate operational telemetry — but it must be named
  for what it is.
- Whether the *hardware* has any real leak detection remains **unverified and
  out of scope** here. This measurement says the software exposes no such
  signal; it makes no claim about the installation. Per the safety boundary
  above, dedicated local detection and alarms stay outside the software-only
  scope regardless.

---

## 🗄️ Ingestion scope — what the collector loads, and what it must never load

Added 2026-09-30. `fact_gas_pressure_sample` carries **three** channels, from
an explicit allow-list in `GAS_CHANNELS` (`apps/etl/src/gas.ts`) rather than an
entity-id pattern, so a new Home Assistant entity cannot be ingested by
accident:

| channel | entity | what it is |
| :--- | :--- | :--- |
| `gas_run_a_pressure` | `sensor.otterimju2_gas_pressure_a` | gas manifold Run A |
| `gas_run_b_pressure` | `sensor.otterimju2_gas_pressure_b` | gas manifold Run B |
| `changeover_filter_pressure` | `sensor.otterimju2_changeover_pressure` | gas **filter** differential — see the naming collision above |

The channel name, not the entity id, is the semantic label. `channel` is a
`LowCardinality`-free `Enum8` so an unexpected label fails the INSERT rather
than landing as free text.

### Deliberately NOT ingested

- **`binary_sensor.otterimju2_gas_detector_a/_b`.** The heartbeat, per the
  section above. Adding these to the allow-list would manufacture a "leak half
  the time" reading. A test asserts the allow-list contains no `gas_detector`
  entity, so this cannot be widened by accident.
- **`gas_rate_a` / `gas_rate_b`** — derivative sensors whose unit is unverified
  in this document, and Home Assistant already computes them from the pressure
  we store. Storing both would put two copies of the same fact under different
  names.
- **`gas_energy_total`, `tank_change_*_monthly`** — cumulative counters and
  month-boundary counts. Different grain, different reset semantics, and only
  144 and 1–3 rows respectively in the measured window. They need their own
  contract, not a column on this table.

### How `unavailable` is stored

`value_psi` is `Nullable(Float32)` and `unavailable` becomes **NULL**, never 0.
`state_raw` keeps the exact source string and `is_available` carries the flag,
so the distinction survives into the warehouse and stays auditable. Measured
on the real export: 18 `unavailable` rows per entity, true numeric minimum
**9 psi**, and **zero** rows with `value_psi = 0`.

### Branch binding

`branch_id` is the join key everywhere and resolves to
`5e9611c1-6380-4d58-8ec7-ba4fb8fe4369` — the `about you.wash & dry แม่โจ้ -
หลิ่งมื่น` row in `dim_branch`, which already holds all 15,850 usage rows and 19
machines. `branch_slug = 'otterimju2'` is stored alongside it so the site can
be found by the name the shop uses, without introducing a second branch identity.

> **This binding is an ops decision, not a discovered fact.** The `otterimju2`
> name comes from the site's own Home Assistant entity ids and public hostname.
> No running configuration on the edge agent or in IRIS was found asserting
> that this site *is* that branch — the one `branch_id` hit in the agent's
> source tree is a Rust **test fixture**, not live config. The two identifiers
> are consistent with the same shop ("otterimju" = แม่โจ้, and this is the only
> แม่โจ้ branch in `dim_branch`), but confirm before this reaches production.
> Re-pointing the collector is two env vars (`GAS_BRANCH_ID`,
> `GAS_BRANCH_SLUG`); it is not a code change.

### Verified 2026-09-30

| Check | Result |
|---|---|
| DDL executed on a real ClickHouse engine (`clickhouse-local`) | creates; Enum8, `LowCardinality`, `ReplacingMergeTree(ingested_at)` all accepted |
| Idempotency — re-insert the same sample with a later `ingested_at` | converges to one row; latest wins (105, not 104) |
| `unavailable` round-trip | stays NULL; `countIf(value_psi = 0)` = 0 |
| ETL unit tests | 26 new, in `apps/etl/test/gas.test.ts` |
| Full ETL suite | 87 pass (was 61) |
| Replay of the **real 50,567-row export** (3 allow-listed entities) | 50,567 rows produced, 0 dropped, 0 unparseable timestamps, no empty channel |
| Replay per channel | a: 5,178 rows / 18 null / min 9 / max 154 · b: 19,738 / 18 / 9 / 141 · filter: 25,651 / 18 / 9 / 25 |
| Home Assistant REST contract | `/api/history/period/<start>?filter_entity_id=…&end_time=…&no_attributes`, offset-aware ISO timestamps, array-of-arrays response — per official docs |

**Not verified:** no live Home Assistant call has been made. There is no token,
so the response shape is documented, not observed. The first real run must be
eyeballed against this table before the data is trusted.

### Retention ceiling

Home Assistant's recorder runs `purge_keep_days: 7`. A collector outage longer
than 7 days is **unrecoverable at the source** — the rows are gone before the
collector returns. `GAS_LOOKBACK_HOURS` defaults to 3 (one missed run plus
overlap, which `ReplacingMergeTree(ingested_at)` converges) and the runner
warns above 7. This is a property of the source, not a tuning choice.

---

## ❓ Unresolved semantics

None of the following may be used, asserted, or written into a schema until
measured. All are present in the entity registry but **not yet measured** —
their existence in the registry is not evidence of meaning.

| Entity | Why it is unresolved |
| :--- | :--- |
| `sensor.r1_last_gas_change_time_a` / `_b` | Timestamp semantics, source clock, and reset behaviour unverified. |
| `sensor.r2_last_gas_change_time_a` / `_b` | As above. Relationship to `r1` unverified. |
| `binary_sensor.otterimju2_gas_detector_a` / `_b` | **MEASURED 2026-09-30 — NOT a gas detector.** Despite the entity id, this is a **liveness heartbeat**, not a leak signal. See "The `gas_detector_*` entities are a heartbeat, not a detector" below. **Never** use these as a leak indicator. |
| `sensor.otterimju1_gas_pressure_a` / `_b` | A **different branch** (`otterimju1`). Same measurement approach applies; not measured. |
| `sensor.otterimju1_changeover_pressure` | As above, and subject to the same naming collision. |
| `timer.otterimju2_change_over_timer` | May relate to the near-daily `unavailable` cluster (Rule 1). Unverified; **not** a cause. |
| `automation.otterimju2_ykelik_force_gas_changeover_10_v2` | As above. Unverified; **not** a cause. |
| `input_number.otterimju2_min_gas_pressure` | A **configured threshold**, not a measurement. Whose threshold, set by whom, and against which entity are all unknown. Must not be mistaken for observed data, and must not be adopted as a LaundryTwin alert threshold without the operator's own choice. |
| `input_number.otterimju2_gas_a_min_pressure`, `…gas_b_min_pressure`, `…desired_gas_pressure` | As above. `desired_*` is in particular a **setpoint**, not a state. |
| `input_number.otterimju2_gas_energy_{a,b}_{cycle,cycle_previous,session_start}` | A large parameter set. Relationship to `gas_energy_total` unverified. |

Also unresolved, and not entity-specific:

- **Tank geometry / capacity.** Without it, psi cannot be converted to
  remaining volume or a percentage. No such mapping has been verified.
- **Temperature compensation.** AGENTS.md requires temperature to be evaluated
  alongside pressure. The branch temperature source (`fact_temperature_sample`)
  and this HA source are on different networks with no verified join key.
- **`gas_pressure` is not an IRIS register.** It has no `register_map_version`
  and must not be given one by association.

---

## ✅ Verified evidence vs unresolved

**Verified by measurement, 2026-09-30:**

- The topology in this document, the MySQL live store, and the stale SQLite
  file (history stops 2026-07-17; zero gas rows).
- `recorder.purge_keep_days: 7`, `auto_purge: true`.
- All eight entities exist, are `platform = mqtt`, and are not disabled.
- `unit_of_measurement: psi`, `device_class: gas`, `state_class: measurement` on
  the pressure entities.
- Every row count, window, average, min, max, and staleness figure in the tables
  above, with the measurement date attached to each.
- The `unavailable`-state synchrony across the three pressure entities (matched
  to within tens of microseconds) and its near-daily time-of-day clustering, plus
  the finding that the true numeric minimum is **9 psi**, not 0.
- The `friendly_name` "ระบบแก๊ส ร้าน 2 แรงดันแก๊ส Filter", which is what
  disqualifies the `changeover_pressure` name.
- The A/B daily ratio spread of 0.066–0.461 across seven full days.

**Unresolved:** everything in "Unresolved semantics", plus the cause of the
A/B asymmetry, the cause of the shared `unavailable` dropouts, the unit of `gas_rate_*`
and `gas_energy_total`, and the reset semantics of every cumulative counter.

**Not established and not claimed:** that this source detects a gas leak; that
R06 is unblocked; that a low-gas threshold can be derived from it; that tank A
or B is empty, low, or leaking; that retention will be extended; that any
pipeline exists.

---

## 🔗 Relationship to other documents

- `docs/03_data_contracts/data_contracts.md` — the general field table. The
  `Gas Pressure` row there remains the governing rule ("Pressure reading with
  units, sensor ID, and sampling window… flag missing sensor data"), and
  `Gas Leak Detected` remains a **separate** field from a dedicated detector.
- `docs/01_requirements/system_requirement.md` — R06 dependencies
  (`gas_pressure`, `temperature`, dryer `state`, `timestamp`) and its constraint
  *"Do NOT use pressure alone to conclude there is a gas leak."* R07 is
  unrelated to this source.
- `AGENTS.md` — "Strict physical and safety boundaries", which this document
  does not relax and does not extend.
- `docs/03_data_contracts/modbus_frame_analysis.md` — the IRIS register map. No
  register in that document corresponds to anything in this one.

## Maintenance

- Re-measure **with a date**; every figure here is a point-in-time measurement
  and the 7-day window means the numbers are already stale.
- When a new field is measured, add it to the provenance table with its
  attributes — and if it is unmeasured, add it to the unresolved table. Do not
  promote an entity to "measured" because it appears in the registry.
- Any move to ingestion requires a new decision record, a `register_map_version`
  question answered for a non-IRIS source, and the retention question settled
  with the user. This contract authorises none of it.
