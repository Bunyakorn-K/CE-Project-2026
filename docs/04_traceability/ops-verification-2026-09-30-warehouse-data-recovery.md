# Ops verification — ClickHouse warehouse data recovery merge (2026-09-30)

## Context

The live analytics warehouse was found to be **missing 17 consecutive days of
usage data**, 2026-08-31 → 2026-09-16. The cause of the *discovery* was
unambiguous: **two Docker volumes existed for the same ClickHouse server UUID
`2158102b-fd34-4a63-820d-6874da88a0bb`**, and they held **disjoint** data. One
volume was live. The other was stale, and it held the days the live one was
missing. A merge recovered the gap.

This record covers what was done, what was proven, and what remains open.
**§1 was updated on 2026-09-30 with the now-established root cause**: the live
volume was rolled back to a 17-day-old tarball after a correct backup of the
live data was deleted. It also corrects two claims that an earlier draft of §1
got wrong.

Measurements quoted here were taken on the real warehouse at
**2026-09-30 11:39:11 UTC** unless another timestamp is given.

---

## 1. Root cause — RESOLVED 2026-09-30 (read this before trusting another restore)

**The live volume was rolled back to a 17-day-old backup, and the correct backup
of the live data was deleted 8 seconds earlier.**

Nothing was deleted from the warehouse. The 17 days were **orphaned, not
destroyed**: the original volume was left intact on the host and still holds
them. What happened is that the live pointer was moved to a snapshot taken
before those days existed.

This section replaces an earlier "unresolved" statement in this record. Two of
that statement's supporting claims were **wrong** and are corrected below.

### 1.1 What actually happened

| When (UTC) | What | Source |
|---|---|---|
| 2026-09-14 05:56:42 → 2026-09-17 10:10:35 | `analytics-clickhouse-1` (container id `3caaf8cb…`) **crash-looped 2,779 times**, ~50 s apart | `journalctl`, `docker-*.scope: Deactivated` |
| …of which **15** were host OOM kills of `clickhouse-serv` | `oom-kill: constraint=CONSTRAINT_NONE … global_oom` — the **host** ran out of memory, not a cgroup limit | kernel journal |
| 2026-09-17 10:10:30–10:10:34 | Operator adds a 4 GiB `/swapfile` (`fallocate`/`mkswap`/`swapon`/`tee -a /etc/fstab`) | sudo journal |
| 2026-09-17 10:10:40 | `clickhouse-memory.xml` (3 GiB cap) written; `compose.yaml.bak-pre-memcap-20260917` | file mtime |
| 2026-09-17 10:10:45 | `docker compose up -d clickhouse` — memcap + swap applied, crash loop stops | sudo journal |
| 2026-09-17 10:12:24 | `docker stop analytics-clickhouse-1` — still not healthy on the live volume | sudo journal |
| 10:12 – 10:30 | Diagnostic throwaways `chtest`, `chtest2`, `chtest3` (bind-mounted `/opt/analytics/ch-logs` to capture the server error log), `chtest4` on a **fresh** volume, `chtest5`, `chtest6`, `chtest7` — all mounting `analytics_clickhouse-data` | sudo journal |
| **10:16:37** | **A correct full backup is taken:** `docker volume create chdata-bak-20260917` then `docker run --rm -v analytics_clickhouse-data:/src:ro -v chdata-bak-20260917:/dst alpine cp -a /src/. /dst/` | sudo journal |
| 10:30:45 | `docker stop vibrant_bohr` (an ad-hoc container holding the live volume) | sudo journal |
| 10:31:54 | `docker volume create analytics_clickhouse-data-restored` | sudo journal; `docker volume inspect` |
| **10:31:55 – 10:32:03** | **The correct backup is destroyed:** `rm -rf /var/lib/docker/volumes/chdata-bak-20260917/_data`, `rmdir`, `docker volume rm chdata-bak-20260917` | sudo journal |
| **10:32:03** | **The restore:**<br>`tar -xzf /opt/backups/pre-upgrade-20260831/clickhouse-data.tgz -C /var/lib/docker/volumes/analytics_clickhouse-data-restored/_data && chown -R 101:101 … && echo RESTORE-OK > /tmp/chrestore.done` | sudo journal |
| 10:42:13 | `compose.yaml.bak-pre-restore-20260917`; compose switches `clickhouse-data` → `clickhouse-data-restored` (declared `external: true`) | file mtime; `diff` |
| 10:42:18 | `docker compose up -d clickhouse` — ClickHouse comes up, because the 2026-08-31 data directory is small enough to fit in memory | sudo journal |

The only backup on the host was `/opt/backups/pre-upgrade-20260831/clickhouse-data.tgz`
— 1,814,455,646 bytes, written **2026-08-31 04:45**, with its newest content
cut at **04:32**. Extracting it rolled the warehouse back to 2026-08-31 04:32.
`analytics_clickhouse-data` was then orphaned, still holding 2026-08-31 04:32 →
2026-09-16.

**Attribution.** Every command above is recorded in the host journal as
`sudo[…]: uunw : PWD=/home/uunw ; USER=root ; COMMAND=…`, over SSH from
`10.10.0.1`. There is no `root` shell history on the host and no operator note,
runbook entry, or CI record of the decision. **The procedure is now known; the
reasoning that chose a 17-day-old tarball over the correct backup sitting on the
same host is not recorded anywhere.**

### 1.2 The fingerprint that proves it (and corrects two earlier claims)

**CORRECTION — the lineages are *not* unrelated.** Both volumes carry the same
server UUID *and the same Atomic table UUID* for `fact_machine_usage`:

```text
analytics_clickhouse-data/_data/data/laundrytwin_analytics/fact_machine_usage
    -> ../../store/390/390b1d99-94e6-49df-b489-c0a3893c9cfa     (mtime 2026-08-08 10:46)
analytics_clickhouse-data-restored/_data/data/laundrytwin_analytics/fact_machine_usage
    -> ../../store/390/390b1d99-94e6-49df-b489-c0a3893c9cfa     (mtime 2026-08-08 10:46)
```

The restored volume is a **mtime-preserving physical copy** (a `tar -x` of the
2026-08-31 tarball), not a fresh init — a fresh init would have minted new table
UUIDs. `tar tzf` of that tarball contains **161** entries under
`store/390/390b1d99-…/`, i.e. it is a snapshot of this very table.

What *does* differ is **part naming**: the stale volume's parts run to offset
**4352** (`all_4298_4352_15`), the restored volume's to **2576**
(`all_2576_2576_1`). Part boundaries are chosen by the merge scheduler, so the
same rows legitimately merge into differently-named parts. **Comparing part
*names* is not comparing lineage** — that is what produced the earlier,
incorrect "unrelated lineages" conclusion.

**The decisive evidence** is the 2026-08-31 boundary in the live warehouse
today. The tarball was cut at 04:32, and 2026-08-31 splits exactly there:

| segment | rows | range |
|---|---:|---|
| before 04:32 — from the tarball, never lost | **35** | 00:10:44.433 → **04:28:47.241** |
| after 04:32 — from the 2026-09-30 merge | **134** | **04:45:47.707** → 21:14:24.030 |

A 17-minute hole straddling the tarball cutoff. 35 rows survived the rollback
and 134 did not, precisely as a 04:32 snapshot predicts. The next usage row
after the gap is **2026-09-17 01:55:33**.

### 1.3 Why it went unnoticed for 13 days

Two independent mechanisms hid the hole, and both are still in place:

1. **The ETL watermark is a forward-only source cursor stored outside the
   warehouse**, on the host at `/opt/laundrytwin-etl/data/etl-watermark.json`
   (`ETL_WATERMARK_PATH`). Restoring the ClickHouse volume does not move it, so
   the ETL resumed at 2026-09-17 and **never re-read 2026-08-31 04:32 →
   2026-09-16**. A warehouse rollback is structurally invisible to the loader.
2. **The freshness DAG only measures recency, not contiguity.**
   `deploy/analytics/dags/laundrytwin_warehouse_freshness.py` ran
   `dateDiff('minute', max(extracted_at), now())`. A hole in the *middle* of the
   range is invisible to it, which is why it reported `state=success` on every
   scheduled run throughout.

   > **CLOSED 2026-09-30.** A `check_usage_continuity` task now runs first in
   > that DAG and asserts continuity on `toDate(started_at)` — the business
   > day, not `extracted_at`, which is the field the two mechanisms above keep
   > fresh. See §1.6. The restore-time guards in §1.5 are a separate, still-open
   > item.

### 1.4 What is still unknown

- **Why ClickHouse would not stay up on the live volume even with the 3 GiB
  memcap and 4 GiB swap.** This is the one genuinely unresolved link. `chtest3`
  bind-mounted `/opt/analytics/ch-logs` specifically to capture the server error
  log, but that directory is **now empty**. `docker logs chtest7` shows only
  config merging followed by exit 76 — the server never printed a cause. Note
  `chtest4` on a *fresh* volume answered `/ping`, so the image and config were
  sound and the fault was in the data directory.
- **Why a 17-day-old tarball was accepted** as a restore source while a correct
  full copy sat on the same host. No record of the decision exists.
- Whether the 39,702 files in the stale volume with mtimes after 2026-09-17
  11:00 (a `tmp_merge_202609_…` under `store/bac/`, 2026-09-18 12:16) indicate
  a server was briefly run against it read-write. Not established; the stale
  volume's size is byte-identical before and after the 2026-09-30 merge
  (7,848,770,665), so §8 is unaffected.

### 1.5 The concrete prevention mechanism

> ### The specific thing that went wrong
>
> **A correct, complete, freshly-taken backup of the live volume existed, and
> was `rm -rf`'d eight seconds before an older, incomplete backup was extracted
> in its place.** Every other step was recoverable. That one was not.

Two guards are missing, and both are cheap:

1. **A restore-source freshness gate.** A restore must assert that its source
   backup is at least as new as the destination it is replacing. Here the source
   was 17 days *older* than the data being replaced, and nothing said so. A
   one-line `stat` on the tarball against the live volume's newest part would
   have refused it.
2. **A post-restore continuity assertion before the compose switch.** Comparing
   `max(extracted_at)` in the restored volume against the pre-restore value
   would have caught this at 10:42 on 2026-09-17 rather than on 2026-09-30.
   `clickhouse-memory.xml` shows the repo already has the pattern for shipping
   pre-applied config gates; the same shape belongs around a restore.

**A fix is warranted but was not implemented** — this investigation is read-only
and no change was made to the production host. The detection gap in §1.3 was a
separate matter and **has since been closed**; see §1.6. The two restore-time
guards above remain open.

### 1.6 The contiguity check (implemented 2026-09-30)

`check_usage_continuity` was added to
`deploy/analytics/dags/laundrytwin_warehouse_freshness.py` and is chained
**before** the freshness tasks, so a hole is on the log above the freshness
lines that will still read green.

The design decision that matters: it counts day buckets of **`started_at`**, the
business timestamp a row is *about*. `extracted_at` would have been useless —
it is precisely the field that stayed minutes-old-fresh throughout the incident
while 17 days of history were gone, and it is the field the forward-only
watermark keeps advancing.

It is deliberately a **warning, not a failure**. A day with no usage is a real
upstream possibility, and a monitor that pages on it trains people to ignore it.
`KNOWN_SOURCE_GAP_DAYS` holds the one evidence-backed exception
(`2026-07-27`, no usage rows in IRIS either) and is commented as short on
purpose: a growing allow-list is how a real regression gets silenced.

Verified 2026-09-30, all against the live warehouse and the real Airflow
3.3.1 image on VM 117, not a mock:

| Check | Result |
|---|---|
| DAG parses under real Airflow 3.3.1 | 4 tasks, no import deprecations |
| `check_usage_continuity` on the recovered warehouse | clean, 2026-09-01 .. 2026-09-30 |
| Same function fed the real pre-recovery day set | flags exactly 2026-09-01 .. 2026-09-16 |
| `find_missing_days` unit assertions (local, 6 cases) | 6/6 pass |

That third row is the point: the check now fails on the shape that hid for
13 days. The unit assertions are a local `python3` harness, not a committed
test — this repository has no Python test runner, and adding one is a larger
change than this fix justifies.

> ### Standing rule, unchanged and now better founded
>
> **Another restore could lose a different window.** Before any future restore,
> backup, volume swap, or host migration, compare the lineage of source and
> destination volumes explicitly — **and compare it by Atomic table UUID and part
> *offset range*, not by part names**, which legitimately differ across merges
> (see §1.2). A matching server UUID proves nothing. Treat 2026-09-30's merge as
> a recovery of a *known* hole; the cause is now known, but no guard exists to
> stop a repeat.
>
> **§5A is orthogonal to this item.** The ฿/cycle measurement there explains why
> the *recovered data* reads the way it does. It says nothing about how the
> data went missing.

---

## 2. Two silent-corruption traps that were caught

Both would have produced a **plausible-looking, wrong** warehouse rather than an
error. Both were caught by review; one was also caught by the engine. **Do not
rely on the engine in future.**

### Trap 1 — `status` Enum8 is numbered differently in the two warehouses

| Member | Stale volume | Live volume |
|---|---:|---:|
| `running` | 3 | 4 |
| `finished` | 4 | 5 |
| `cancelled` | 5 | 6 |
| `admitted` | 6 | 3 |

A **positional** copy (column N to column N) transposes every `status` value.
The row count stays identical, the revenue stays identical, the queries still
return numbers — and every status is wrong. `pending_payment` and `paid` agree
by coincidence, which makes the damage look partial and therefore harder to
spot. The live volume's numbering is the IRIS lifecycle order decided 2026-09-29
(`pending_payment=1, paid=2, admitted=3, running=4, finished=5, cancelled=6`,
matching `apps/etl/src/schema.ts`); the stale volume predates it.

**Rule this implies:** always map `status` **by name**, never by ordinal.

### Trap 2 — `status` is at a different ordinal position

`status` is **position 14** in the stale volume and the **last column** in the
live volume. A positional copy therefore also shifts or drops the columns around
it (`initiated_via`, `attribution_state`, `attribution_source`,
`source_created_at`, `source_updated_at`, `extracted_at`).

**ClickHouse rejected the ordinal copy outright** with `CANNOT_CONVERT_TYPE`,
so this was caught by the engine as well as by review. That was luck, not
design: the type of the column at that offset did not line up. Had the
neighbouring columns happened to share a type, the copy would have succeeded and
silently mis-assigned six columns. **The next ordinal copy may not be rejected.**

---

## 3. `fact_temperature_sample` has no de-duplication

The table is a **plain `MergeTree`** with no de-duplication, so duplicates are
permanent rows, not collapsible-on-read behaviour.

**An anti-join alone was insufficient.** The first attempt inserted 212,636
candidate rows, but those contained only **205,857 distinct sort keys** —
**6,779 permanent duplicates would have survived the anti-join** and been
inserted. A `row_number()` collapse was required to get to 205,857.

### Usage de-duplication: 27 overlaps, all provably safe to drop

Overlapping usage rows: **27**. Every one was an **exact `source_updated_at`
tie** — 0 rows where the incoming copy was newer, 0 where it was older. Dropping
them was therefore a **proven no-op**, not a judgement call about which copy
wins.

### Set-difference recovery: 22 `started_at IS NULL` rows

A separate set difference recovered **22 rows with `started_at IS NULL`**.
The arithmetic: A = **523** stale keys, B = **511** live keys, A∩B = **501**,
so A−B = **22**.

> **The naive `523 − 511 = 12` is invalid** unless B ⊆ A. B is a *different*
> set, not a subset, and the keys it adds are not all in A. Always compute the
> actual set difference; never subtract two counts and call it a set.

---

## 4. Pre-existing duplicate excess in live `fact_temperature_sample`

**1,503,920 duplicate sort keys** in the live table, measured 2026-09-30
11:39:11 UTC:

| Fact | Value |
|---|---|
| Total rows | 3,760,465 |
| Distinct `(tenant_id, branch_id, occurred_at, event_id)` | 2,256,545 |
| **Duplicate excess** | **1,503,920** |
| `min(occurred_at)` | 2026-05-26 15:51:50.633 |
| `max(occurred_at)` | 2026-09-29 11:37:18.725 |
| Distinct day buckets | 126 |

**This predates the 2026-09-30 work and was not caused by it.** It is
**not fixable in place** — the table is a plain `MergeTree`, so removing
duplicates requires a **table rewrite** (insert `row_number()`-collapsed rows
into a new table, then swap). That rewrite has not been done. Until it is, any
`count()` over this table is a count of reads, not of distinct readings, and
`FINAL` does not help because the engine offers no de-duplication.

---

## 5. Coverage after the merge

### `fact_machine_usage` — 2026-09-30 11:39:11 UTC

- **7,908** rows final; `countDistinct(tenant_id, branch_id, usage_id)` is also
  **7,908**, so the `ReplacingMergeTree` key is 1:1 and the merge introduced no
  key collision. Raw (non-`FINAL`) count **7,911**.
- `started_at IS NULL`: **533**.
- `machine_session_id IS NULL`: **5,369** = **67.8933%** (measured twice, 11:35:11Z
  and 11:39:11Z, identical; see §6 for what backs those two reads).
- `min(started_at)` **2026-07-22 07:15:57.214**, `max(started_at)`
  **2026-09-30 11:28:07.611**.
- Canonical cycle KPI `countIf(status IN ('paid','finished'))` = **6,666**.
- `sum(amount_satang)` all rows **33,617,000** (฿336,170);
  `status IN ('paid','finished')` **32,265,000** (฿322,650).
- `countDistinct(machine_session_id)` = **2,539**;
  `uniqExactIf(machine_session_id, status IN ('paid','finished'))` = **1,589**.
- `status` breakdown: `pending_payment` 2, `paid` 262, `admitted` 28,
  `running` 972, `finished` 6,404, `cancelled` 240.
- `attribution_state`: `exact` 2,540 / `pending_attribution` 5,368 (67.8806%).

**Price band.** Three rows use the ฿322,650 `status IN ('paid','finished')`
numerator; the `count()` row uses the ฿336,170 all-rows numerator, because an
unfiltered row count has to divide all rows' revenue to be a like-for-like
฿/row.

| definition | count | numerator | ฿/cycle |
|---|---:|---|---:|
| session-distinct paid/finished | 1,589 | ฿322,650 paid/finished | ฿203.05 |
| `countDistinct` no filter | 2,539 | ฿322,650 paid/finished | ฿127.08 |
| **row count paid/finished — canonical** | **6,666** | ฿322,650 paid/finished | **฿48.40** |
| `count()` no filter | 7,908 | **฿336,170 all rows** | ฿42.51 |

**This does not re-confirm the canonical cycle definition, and it is recorded
as the opposite of a confirmation.** The row-count definition now reads
**฿48.40/cycle, above the plausible ฿40–45 band** for a Thai self-service
wash, and the only definition inside the band is the unfiltered `count()`, which
this repository has already rejected as a cycle count because it includes
cancelled, admitted, and running work. The 2026-09-29 decision stands **on its
own 2026-09-29 evidence**, which was collected on a corpus that did sit inside
the band (฿42.20); this measurement neither re-confirms nor invalidates it,
because the corpus underneath it changed.

What is unchanged is the **ranking**: the row-count definition remains the
closest of the four to a real wash, and the two session-distinct alternatives
remain implausible at roughly **3× to 5×** a ฿40–45 wash (฿127.08 and ฿203.05) —
far enough out that no plausible Thai wash price makes either of them the
better answer.

> **Update 2026-09-30 12:45 UTC:** the unproven cause flagged in this block
> has now been **measured — see §5A. The hypothesis is CONFIRMED**, with the
> mechanism refined: it is a **row-mix** effect, not a price effect. The
> original text of this paragraph is kept below unchanged, because §5A is
> easier to read against it than instead of it.
>
> The recovered days are **72.6929%** unattributed against the complement's
> **61.7752%**, and they supply **95.01%** of their own `paid`/`finished` rows
> as unattributed against the complement's **66.35%**. §5A shows this is the
> whole of the ฿/cycle move.

One cause is **consistent with the numbers but is not proven**: the 17
recovered days are heavily unattributed, so they add rows to a row count
without adding sessions to any session-distinct count, which pulls the
row-count ฿/cycle upward. The arithmetic fits that shape — the corpus grew
from 5,146 rows (measured 2026-09-29 15:45Z) to 7,908, a delta of 2,762, and
the 17 recovered days alone account for **2,644** of those rows (§5, day
coverage), leaving only 118 for 2026-09-26…2026-09-30. Confirming or refuting
the explanation needs its own measurement — an `attribution_state` /
`machine_session_id` breakdown restricted to 2026-08-31…2026-09-16 — which has
**not** been run, and the unattributed share of those 17 days specifically is
**unknown**. Treat the reason as an open question, not a finding.

See "Canonical cycle definition" in `docs/04_traceability/RTM_matrix.md`.

**Day coverage: 70 distinct day buckets across the 71 calendar days
2026-07-22…2026-09-30.** Every one of the 17 days **2026-08-31 … 2026-09-16**
now has rows — 169, 129, 160, 173, 160, 189, 230, 120, 103, 144, 131, 135, 202,
208, 117, 118, 156 respectively, summing to **2,644 rows**. **2026-07-27 is the
only usage gap day, and it is a genuine source gap, not a merge artefact.**

### `fact_temperature_sample` — 2026-09-30 11:39:11 UTC

See §4 for totals. **2026-06-17 is the only missing day** in the temperature
range, and it **predates the warehouse's first usage row (`min(started_at)`
2026-07-22) by 35 days**. It is therefore outside every window the usage
analytics can be joined against and does not affect cycle or revenue figures.

### `fact_weather_sample`

**196** rows.

---

## 5A. The ฿48.40 mechanism, measured — the attribution hypothesis is CONFIRMED

**Measured 2026-09-30 12:15:29 – 12:45:12 UTC**, read-only `SELECT` against the
live production warehouse, `fact_machine_usage FINAL`, real rows only
(`NOT startsWith(source_event_id, 'synthetic:')`; the real-row filter is a
no-op on this corpus — `synthetic_rows` measured **0**). `status` filtered
**by name** throughout, never by ordinal. `FINAL` was used on every query.

This section resolves the open question recorded in §5 and in
`docs/07_handoffs/2026-09-30-next-session-plan.md` (PRIORITY 2): whether the 17
recovered days are heavily unattributed, and whether that is what pulled the
row-count ฿/cycle from the ฿42.20 band to ฿48.40.

> ### The corpus moved under the measurement
>
> The ETL was still ingesting. The §5 baseline of **7,908** rows was **7,921**
> rows by the end of this measurement window, and the 533 NULL-`started_at`
> rows had become **534**. Every figure below carries its own timestamp. This
> is the same live-metric caveat §5 already records, observed in real time.
> It does not affect any conclusion here: the recovered/complement contrast is
> far larger than the drift.

### Group definitions

| group | definition |
|---|---|
| **A — recovered 17d** | `toDate(started_at)` between `2026-08-31` and `2026-09-16` |
| **B — complement** | everything else with a non-NULL `started_at` |
| **C — unassignable** | `started_at IS NULL` |

Group **C** exists because **534 rows have `started_at IS NULL`** and therefore
**cannot be assigned to a day at all**. They are reported separately rather than
being silently folded into the complement; doing so would misstate whichever
group absorbed them.

### 5A.1 The two groups, measured identically — 12:45:12 UTC

| Fact | A — recovered 17d | B — complement | C — unassignable |
|---|---:|---:|---:|
| Rows | **2,644** | **4,743** | **534** |
| `machine_session_id IS NULL` | **1,922** | **2,930** | **524** |
| **% unattributed** | **72.6929%** | **61.7752%** | **98.1273%** |
| `attribution_state` `exact` | 722 | 1,814 | 10 |
| `attribution_state` `pending_attribution` | 1,922 | 2,929 | 524 |
| `paid`/`finished` rows | 2,005 | 4,404 | 263 |
| `paid`/`finished` satang | 12,013,000 | 18,443,000 | 1,843,000 |
| `uniqExact(machine_session_id)` | 722 | 1,813 | 10 |
| paid/finished sessions | 100 | 1,482 | 7 |

**Group A is materially more unattributed than group B: 72.6929% against
61.7752%, a gap of 10.92 percentage points, and 1,922 of 1,922 `pending_
attribution` rows carry no session id.** That is the hypothesis, and it holds.

Note the exact/pending counts and the NULL-session count do not correspond
one-for-one in either group (A: 722 exact vs 722 sessions, but 1,922 pending vs
1,922 NULL — these *do* line up in group A; in B they are 1,814 / 1,813 and
2,929 / 2,930, a one-row offset in **each** direction). This is the known
`machine_session_id` / `attribution_state` independence already recorded in
§6 and in `RTM_matrix.md`; it is unchanged and unexplained, and it does not
affect the unattributed-share comparison, which is computed from
`machine_session_id` alone.

### 5A.2 ฿/cycle per group, under all three definitions — 12:45:12 UTC

| definition | A — recovered 17d | B — complement | C — unassignable |
|---|---:|---:|---:|
| **row count paid/finished — canonical** | 2,005 → **฿59.92** | 4,404 → **฿41.88** | 263 → ฿70.08 |
| `uniqExactIf` session-distinct paid/finished | 100 → ฿1,201.30 | 1,482 → ฿124.45 | 7 → ฿2,632.86 |
| `uniqExact` session-distinct, no filter | 722 → ฿166.39 | 1,813 → ฿101.73 | 10 → ฿1,843.00 |

**Working**, canonical row count: A = 12,013,000 / 100 / 2,005 = ฿59.92;
B = 18,443,000 / 100 / 4,404 = ฿41.88. All three = 32,299,000 / 100 / 6,672
= **฿48.41**, matching the §5 corpus figure of ฿48.40 to the rounding (the
corpus grew 13 rows in the interval between the two reads).

**The arithmetic of the ฿42.20 → ฿48.40 move, stated explicitly:** the
recovered days on their own read **฿59.92/cycle**, and the pre-existing corpus
without them reads **฿41.88/cycle** — inside the plausible ฿40–45 band. The
recovered days are simply a **more expensive-looking** block, and blending
them into a corpus that was previously almost entirely the cheap block moves
the whole-corpus ratio up. Note also that group A's session-distinct figures
are **absurd** (฿1,201.30 and ฿166.39), far worse than the corpus they replaced,
because only **100** of A's 2,005 paid/finished rows carry a session id.

### 5A.3 Why it is a MIX effect, not a PRICE effect — the crux

This is the part that needed measuring, and it separates two explanations that
the top-line numbers alone cannot tell apart: "the recovered days are more
expensive per row" versus "the recovered days have proportionally fewer
session-bearing rows, so the same revenue is spread over more rows".

Measured at **12:43:48 UTC**, restricted to `paid`/`finished` rows:

| group | paid/finished rows | of which unattributed | % of paid/finished rows unattributed | satang per **unattributed** pf row | satang per **attributed** pf row |
|---|---:|---:|---:|---:|---:|
| **A — recovered 17d** | 2,005 | 1,905 | **95.01%** | **6,306.0** | **0.0** |
| **B — complement** | 4,404 | 2,922 | 66.35% | 6,273.4 | 75.6 |
| **C — unassignable** | 263 | 256 | 97.34% | 7,007.8 | 7,000.0 |

**Revenue per unattributed paid/finished row is essentially identical across
the two groups — 6,306 satang (฿63.06) in A against 6,273.4 satang (฿62.73) in
B, a 0.5% difference.** A recovered day and a pre-existing day cost the same
amount per unattributed cycle. **The price is not what changed.**

What changed is the **mix**: group A draws **95.01%** of its paid/finished
rows from the unattributed pool, against **66.35%** for the complement. The
corpus-wide ratio is a revenue-weighted blend, so blending in a block that is
95% unattributed raises the average even though neither block changed price.

A counterfactual makes this concrete. Holding each group's own observed
revenue-per-row, but reassigning group A's 2,005 paid/finished rows to the
complement's 66.35% unattributed mix (12:44:26 UTC):

```
corpus ฿/cycle ACTUAL                        = ฿48.41
corpus ฿/cycle COUNTERFACTUAL (A at B's mix) = ฿43.05
```

**At the complement's attribution mix the same data would read ฿43.05 —
inside the plausible ฿40–45 band.** The entire overshoot above the band is
attributable to the recovered days' attribution mix, and to nothing else in
this measurement.

### 5A.4 Temporal context — the recovered days are not anomalous

The comparison above is against the *whole* complement, which spans a long
near-zero-revenue July period. Splitting the corpus into eras (12:15:29 UTC)
shows the recovered days are **typical of their own era**, not outliers:

| era | rows | % unattributed | paid/finished rows | ฿/cycle (row count) |
|---|---:|---:|---:|---:|
| 2026-07-22 … 2026-08-20 | 888 | **6.53%** | 886 | **฿3.35** |
| 2026-08-21 … 2026-08-30 | 1,754 | 73.32% | 1,682 | ฿48.60 |
| **2026-08-31 … 2026-09-16 (recovered)** | **2,644** | **72.69%** | **2,005** | **฿59.92** |
| 2026-09-17 … 2026-09-30 | 2,099 | 75.51% | 1,835 | ฿54.31 |
| `started_at IS NULL` | 533 | 98.12% | 263 | ฿70.08 |

**The July 22 – August 20 block is 6.53% unattributed and reads ฿3.35/cycle —
it is the reason the corpus-wide unattributed share (67.87%) is lower than the
recovered days' own 72.69%.** Removing that block, the unattributed share of
everything from 2026-08-21 onward is **73.77%** (12:44:34 UTC), which is
*above* the recovered days' 72.69%. **The recovered days are slightly LESS
unattributed than the era they sit in** (72.69% vs 74.50% for 2026-08-21 →
2026-09-30 excluding them, 12:44:26 UTC).

This does not weaken the confirmation — the recovered days still pull the
row-count ฿/cycle up, and §5A.3's counterfactual still lands at ฿43.05 — but
it does correct the framing. **They are not anomalously unattributed; they are
a normal high-volume block from a period when attribution had degraded, and the
฿/cycle rise is the July cheap block being diluted out of the corpus average.**

### 5A.5 1:1 session cardinality, re-measured on the migrated warehouse

The 2026-09-29 decision rests on cardinality being 1:1. That was measured before
the status-enum migration and **never re-measured**. Re-measured **by hand**,
`status` filtered **by name**, on 2026-09-30, because
`apps/api/scripts/cycle-cardinality-diagnostic.ts` refuses to run against a
migrated warehouse by design. The script's `buildSessionSpanSummarySQL` is
status-free and was used as the shape; in `buildMultiStatusSessionSQL` the
frozen `status IN (2, 4)` was replaced with `status IN ('paid','finished')`, per
the handoff's instruction. **The script itself was not modified or executed.**

12:20:17 UTC — rows per session:

| Fact | Value |
|---|---|
| `session_ids` | 2,544 |
| `min` / `max` rows per session | **1 / 1** |
| `avg` rows per session | 1 |

12:41:59 UTC — statuses per session:

| Fact | Value |
|---|---|
| `session_ids` | 2,545 |
| `multi_status_session_ids` | **0** |
| `multi_revenue_status_session_ids` | **0** |
| `max_distinct_statuses` / `max_revenue_statuses` | 1 / 1 |

**Cardinality is still exactly 1:1, and no session id carries more than one
status.** The 2026-09-29 claim the decision rests on **survives the migration
and the merge**, re-measured by name. (The 2,544 vs 2,545 difference between
the two reads is corpus drift, one row arriving between 12:20 and 12:41.)

This means the two families of definition can still differ **only** through
*missing* attribution, never through fan-out — which is exactly the gap §5A.3
measures.

### 5A.6 Boundary sanity check

12:43:34 UTC, calendar 2026-07-22 → 2026-09-30 built with `numbers(71)`:

| Fact | Value |
|---|---|
| Calendar days in span | 71 |
| Days with rows | **70** |
| Missing days | **2026-07-27** (only) |
| Recovered days present | **17 of 17** |

**All 17 recovered days have rows, and 2026-07-27 is still the only gap.** The
boundary used throughout §5A is sound.

### 5A.7 What this does and does not establish

**Established:**

- The recovered days **are** more unattributed than the pre-existing corpus
  (72.6929% vs 61.7752%), and supply 95.01% of their paid/finished rows as
  unattributed against 66.35%. **The hypothesis is CONFIRMED.**
- The mechanism is **row mix, not price**: revenue per unattributed
  paid/finished row is 6,306 satang in the recovered days against 6,273.4 in
  the complement — a 0.5% difference.
- At the complement's attribution mix the same data reads **฿43.05**, inside
  the plausible band. The overshoot is fully accounted for.
- 1:1 session cardinality **still holds** on the migrated, merged warehouse.
- Day coverage and the single 2026-07-27 gap are **unchanged**.

**Not established, and explicitly not claimed:**

- **This does not re-confirm the cycle-KPI decision.** The decision stands on
  its 2026-09-29 evidence and, if anything, is **weaker**: the ฿/cycle
  agreement that supported it is now explained as an artefact of *which rows
  happen to carry attribution*, not as evidence that a row is a wash. A
  metric whose ฿/cycle sits inside a plausible band only because unattributed
  rows are cheap-per-session is **not** thereby validated.
- The 2026-07-22 → 2026-08-20 block's **6.53%** unattributed share and
  **฿3.35/cycle** are unexplained. That block is why the corpus-wide
  unattributed share is as low as it is, and it is not part of the recovered
  data. **No cause is claimed for it.**
- `machine_session_id` and `attribution_state` remain **independent columns**
  with a one-row offset in group B, as §6 and `RTM_matrix.md` already record.
  Unreconciled; no cause claimed.
- Whether ฿63 per unattributed cycle is itself a *correct* wash price is
  **untested**. This measurement shows the two groups agree on it; it does not
  validate it against a real till.

### 5A.8 SQL run

All read-only. Executed as `clickhouse-client` **inside** `analytics-clickhouse-1`
(database `laundrytwin_analytics`), which picks up `CLICKHOUSE_PASSWORD` from
that container's own environment, so no `--password` was ever passed and no
secret was printed. Reached only via the bastion, with a throwaway
`-o UserKnownHostsFile` under `/tmp` that was deleted afterwards;
`~/.ssh/known_hosts` was never touched. No `OPTIMIZE`, no `FINAL` on the
projection, no writes, no container restarts.

```sql
-- 5A.1 / 5A.2  group split, measured identically per group
WITH base AS (
  SELECT * FROM fact_machine_usage FINAL
  WHERE NOT startsWith(source_event_id, 'synthetic:')
),
grp AS (
  SELECT
    multiIf(
      started_at IS NULL, 'C_unassignable_started_at_NULL',
      toDate(started_at) BETWEEN toDate('2026-08-31') AND toDate('2026-09-16'),
        'A_recovered_17d',
      'B_complement') AS grp,
    machine_session_id, status, amount_satang
  FROM base
)
SELECT now() AS measured_at_utc, grp,
  count() AS rows,
  countIf(machine_session_id IS NULL) AS null_sess,
  round(100.0 * countIf(machine_session_id IS NULL) / count(), 4) AS pct_null_sess,
  countIf(status IN ('paid','finished')) AS pf_rows,
  sumIf(amount_satang, status IN ('paid','finished')) AS pf_sat,
  uniqExact(machine_session_id) AS sessions_all,
  uniqExactIf(machine_session_id, status IN ('paid','finished')) AS sessions_pf,
  round(pf_sat / 100.0 / pf_rows, 2)                AS baht_per_rowcount,
  round(pf_sat / 100.0 / sessions_pf, 2)            AS baht_per_session_pf,
  round(pf_sat / 100.0 / sessions_all, 2)           AS baht_per_session_all
FROM grp GROUP BY grp ORDER BY grp;

-- 5A.1  attribution_state per group
WITH base AS (
  SELECT * FROM fact_machine_usage FINAL
  WHERE NOT startsWith(source_event_id, 'synthetic:')
),
grp AS (
  SELECT multiIf(
      started_at IS NULL, 'C_unassignable_started_at_NULL',
      toDate(started_at) BETWEEN toDate('2026-08-31') AND toDate('2026-09-16'),
        'A_recovered_17d',
      'B_complement') AS grp,
    attribution_state
  FROM base
)
SELECT grp, attribution_state, count() AS n
FROM grp GROUP BY grp, attribution_state ORDER BY grp, attribution_state;

-- 5A.3  THE CRUX: mix vs price, on paid/finished rows only
WITH base AS (
  SELECT * FROM fact_machine_usage FINAL
  WHERE NOT startsWith(source_event_id, 'synthetic:')
),
grp AS (
  SELECT multiIf(
      started_at IS NULL, 'C_unassignable_started_at_NULL',
      toDate(started_at) BETWEEN toDate('2026-08-31') AND toDate('2026-09-16'),
        'A_recovered_17d',
      'B_complement') AS grp,
    if(machine_session_id IS NULL, 'unattributed', 'attributed') AS attrib,
    status, amount_satang
  FROM base
)
SELECT now() AS measured_at_utc, grp,
  countIf(status IN ('paid','finished')) AS pf_rows,
  countIf(status IN ('paid','finished') AND attrib = 'unattributed') AS pf_rows_unattributed,
  round(100.0 * countIf(status IN ('paid','finished') AND attrib = 'unattributed')
        / countIf(status IN ('paid','finished')), 2) AS pct_pf_rows_unattributed,
  round(sumIf(amount_satang, status IN ('paid','finished') AND attrib = 'unattributed')
        / greatest(countIf(status IN ('paid','finished') AND attrib = 'unattributed'), 1), 1)
        AS sat_per_UNATTRIBUTED_pf_row,
  round(sumIf(amount_satang, status IN ('paid','finished') AND attrib = 'attributed')
        / greatest(countIf(status IN ('paid','finished') AND attrib = 'attributed'), 1), 1)
        AS sat_per_ATTRIBUTED_pf_row
FROM grp GROUP BY grp ORDER BY grp;

-- 5A.3  counterfactual: A's pf rows at B's unattributed mix
-- (b_pf_un/b_pf) is B's mix; A's unattributed rows keep A's observed
-- revenue/row; rows demoted to 'attributed' earn B's observed attributed
-- revenue/row (112000 sat / 1482 rows).
WITH base AS (
  SELECT * FROM fact_machine_usage FINAL
  WHERE NOT startsWith(source_event_id, 'synthetic:')
),
grp AS (
  SELECT multiIf(
      started_at IS NULL, 'C_null',
      toDate(started_at) BETWEEN toDate('2026-08-31') AND toDate('2026-09-16'), 'A',
      'B') AS grp,
    if(machine_session_id IS NULL, 'unattributed', 'attributed') AS attrib,
    status, amount_satang
  FROM base
),
agg AS (
  SELECT grp,
    countIf(status IN ('paid','finished')) AS pf,
    countIf(status IN ('paid','finished') AND attrib = 'unattributed') AS pf_un,
    sumIf(amount_satang, status IN ('paid','finished')) AS pf_sat
  FROM grp GROUP BY grp
),
x AS (
  SELECT
    maxIf(pf, grp = 'A') AS a_pf, maxIf(pf_un, grp = 'A') AS a_pf_un,
    maxIf(pf_sat, grp = 'A') AS a_sat,
    maxIf(pf, grp = 'B') AS b_pf, maxIf(pf_un, grp = 'B') AS b_pf_un,
    maxIf(pf_sat, grp = 'B') AS b_sat,
    maxIf(pf, grp = 'C_null') AS c_pf, maxIf(pf_sat, grp = 'C_null') AS c_sat
  FROM agg
)
SELECT now() AS measured_at_utc,
  a_pf, b_pf, c_pf,
  round(100.0 * a_pf_un / a_pf, 2) AS a_mix_pct_unattributed,
  round(100.0 * b_pf_un / b_pf, 2) AS b_mix_pct_unattributed,
  round((a_sat + b_sat + c_sat) / 100.0 / (a_pf + b_pf + c_pf), 2)
    AS corpus_baht_per_cycle_ACTUAL,
  round((
      b_sat + c_sat
    + round(b_pf_un / b_pf, 6) * a_pf * (a_sat / a_pf_un)
    + (1 - round(b_pf_un / b_pf, 6)) * a_pf * ((112000.0 / 1482))
    ) / 100.0 / (a_pf + b_pf + c_pf), 2)
    AS corpus_baht_per_cycle_COUNTERFACTUAL
FROM x;

-- 5A.4  era decomposition
WITH base AS (
  SELECT * FROM fact_machine_usage FINAL
  WHERE NOT startsWith(source_event_id, 'synthetic:')
),
grp AS (
  SELECT multiIf(
      started_at IS NULL, 'C_null_started_at',
      toDate(started_at) <  toDate('2026-08-21'), 'C1_pre_2026-08-21',
      toDate(started_at) <= toDate('2026-08-30'), 'C2_2026-08-21..08-30',
      toDate(started_at) <= toDate('2026-09-16'), 'A_recovered_08-31..09-16',
      'C3_2026-09-17..09-30') AS grp,
    machine_session_id, status, amount_satang
  FROM base
)
SELECT grp, count() AS rows,
  countIf(machine_session_id IS NULL) AS null_sess,
  round(100.0 * countIf(machine_session_id IS NULL) / count(), 2) AS pct_null_sess,
  countIf(status IN ('paid','finished')) AS pf_rows,
  sumIf(amount_satang, status IN ('paid','finished')) AS pf_sat,
  round(sumIf(amount_satang, status IN ('paid','finished')) / 100.0
        / countIf(status IN ('paid','finished')), 2) AS baht_per_pf_row
FROM grp GROUP BY grp ORDER BY grp;

-- 5A.5  1:1 cardinality, by hand, status-free (shape of
-- apps/api/scripts/cycle-cardinality-diagnostic.ts buildSessionSpanSummarySQL)
SELECT now() AS measured_at_utc,
  count() AS session_ids,
  min(rows_per_session) AS min_rows,
  max(rows_per_session) AS max_rows,
  round(avg(rows_per_session), 4) AS avg_rows
FROM (
  SELECT machine_session_id, count() AS rows_per_session
  FROM fact_machine_usage FINAL
  WHERE NOT startsWith(source_event_id, 'synthetic:')
    AND machine_session_id IS NOT NULL
  GROUP BY machine_session_id
);

-- 5A.5  multi-status, by NAME (the script's frozen `status IN (2, 4)`
-- replaced with `status IN ('paid','finished')`, per the handoff)
SELECT now() AS measured_at_utc,
  count() AS session_ids,
  countIf(distinct_statuses > 1)    AS multi_status_session_ids,
  countIf(revenue_statuses > 1)     AS multi_revenue_status_session_ids,
  max(distinct_statuses)            AS max_distinct_statuses,
  max(revenue_statuses)             AS max_revenue_statuses
FROM (
  SELECT machine_session_id,
    uniqExact(status)    AS distinct_statuses,
    uniqExactIf(status, status IN ('paid','finished')) AS revenue_statuses
  FROM fact_machine_usage FINAL
  WHERE NOT startsWith(source_event_id, 'synthetic:')
    AND machine_session_id IS NOT NULL
  GROUP BY machine_session_id
);

-- 5A.6  boundary check
WITH cal AS (
  SELECT toDate('2026-07-22') + toIntervalDay(number) AS d FROM numbers(71)
),
have AS (
  SELECT DISTINCT toDate(started_at) AS d
  FROM fact_machine_usage FINAL
  WHERE NOT startsWith(source_event_id, 'synthetic:') AND started_at IS NOT NULL
)
SELECT (SELECT now() FROM cal LIMIT 1) AS measured_at_utc,
  (SELECT count() FROM cal) AS calendar_days,
  (SELECT count() FROM have) AS days_with_rows,
  (SELECT arrayStringConcat(arraySort(groupArray(toString(d))), ', ')
     FROM (SELECT d FROM cal WHERE d NOT IN (SELECT d FROM have))) AS missing_days,
  (SELECT count() FROM have
     WHERE d BETWEEN toDate('2026-08-31') AND toDate('2026-09-16')) AS recovered_days_present;
```

**Provenance.** As with §5, these figures come from a read-only `SELECT` pass
whose results are **not** written to any file on the host, so they are
**re-measurable but not re-readable**. The SQL above is recorded so the pass
can be repeated; it is not a substitute for a captured output. The same
consequence as §6: **a future merge or ETL ingest changes these numbers and
nothing on disk will say so.**

---

## 6. Rollback material and figure provenance

All rollback material lives in **`/opt/backups/pre-merge-20260930/` on VM 117**,
**mode 0700**. It contains the staged Native-format files, `merge_predicate.txt`,
and `01-merge-result.txt`. This path is recorded here; its contents are not
mirrored into this repository.

### Where each figure in this record came from

A verification record is only as good as the traceability of its numbers, so
each block below states whether the figures can be re-checked against a file on
VM 117. Nothing here is quoted from memory.

| Figures | Provenance |
|---|---|
| Merge command record, pre/post row counts, and the Step-4 measurements in §3 (212,636 candidates / 205,857 distinct / 6,779 duplicates, 27 overlaps, 523 / 511 / 501 / 22 set difference) | `/opt/backups/pre-merge-20260930/01-merge-result.txt` (**340 lines**), with supporting evidence in `/opt/backups/pre-merge-20260930/_phase2/` |
| Merge window predicate, and the rollback recipe | `merge_predicate.txt` in the same directory |
| §4 temperature duplicate excess (3,760,465 / 2,256,545 / 1,503,920) and §5 usage totals (7,908, 5,369, 6,666, 33,617,000, 32,265,000, 2,539, 1,589, `status` and `attribution_state` breakdowns), the price band, and the `fact_weather_sample` count of 196 | **Read-only `SELECT` against the live warehouse at 2026-09-30 11:36–11:41 UTC**, not written to a file on the host. These are **not** in the backup directory, so they cannot be re-read without re-running the queries. |
| The **second** read behind "measured twice, 11:35:11Z and 11:39:11Z" in §5 and in `RTM_matrix.md` | Same read-only pass. It is a separate query execution, not a mirror of one; the identical value is a genuine two-read agreement, but the two timestamps are recorded from the operator's run log, **not** from a file this repository can point at. |
| The 17 per-day row counts in §5 (169, 129, … 156, summing to 2,644) | Captured in the **`/opt/backups/pre-merge-20260930/01-merge-result.txt` command record** as a per-day post-merge listing. The mapping from each of the 17 dates to its count is reproduced here in date order, but the count↔date association is **this record's**, not a line-by-line copy of the host file; re-verify per-day figures by re-running the `GROUP BY toDate(started_at)` query rather than by trusting this list alone. |
| Airflow restart facts in §7, health endpoints and DAG results in §9, the volume fingerprint in §8 | Observed on the host during the merge window (`docker inspect`, the DAG's own run history). **No file in `/opt/backups/pre-merge-20260930/` backs these**, and they are not reproduced from a captured output here. |

The practical rule this section establishes: figures with a file behind them
are re-checkable, and figures without one are not. The second set includes
most of §5, including the price band, so **a future merge changes those numbers
and nothing on disk will say so** — re-measure rather than inheriting them.

> **The temperature rollback predicate would also match 95 pre-existing live
> rows.** Reverting the temperature merge by predicate alone would therefore
> delete 95 rows that were never part of the merge. A **whole-table restore** is
> the cleaner path for that table, and is the path to prefer.

---

## 7. The three unexplained `analytics-airflow-*` container restarts

Three Airflow containers — `analytics-airflow-scheduler-1`,
`analytics-airflow-triggerer-1`, `analytics-airflow-dag-processor-1` — restarted
at **~11:02–11:05Z** on 2026-09-30, during the merge window.

| Fact | Value |
|---|---|
| `RestartCount` | 1 |
| `ExitCode` | 0 |
| `OOMKilled` | false |
| Host free memory at the time | **838 MiB** (attributable to a throwaway ClickHouse copy) |
| DAG behaviour | `laundrytwin_warehouse_freshness` ran **continuously** before, during and after |

**Trigger undetermined.** The exits were clean (`ExitCode=0`, no OOM kill) and
the DAG did not miss a run, so there is no functional impact and no evidence of
data loss. But the **cause is not known**, and low free memory from the
throwaway copy is a plausible contributing factor that was never confirmed.
Do not record these restarts as "expected" or "benign" until the trigger is
known.

---

## 8. What was confirmed NOT to have been touched

- **`analytics_clickhouse-data` was never mutated.** Its fingerprint is
  unchanged, its size is **7,848,770,665 bytes** before and after, and the
  server UUID is **identical** before and after
  (`2158102b-fd34-4a63-820d-6874da88a0bb`).
- **`analytics-clickhouse-1` was never restarted.**

The merge read the stale volume and wrote into the live one through the normal
ClickHouse path; it did not swap, remount, or replace the live volume, and it
did not bounce the ClickHouse container.

---

## 9. Post-merge health evidence

- **401 on all five health endpoints** after the merge.
- The **ETL watermark is advancing** (not stalled, not rewound).
- The `laundrytwin_warehouse_freshness` DAG reports **`state=success` on every
  scheduled run from 04:00Z through 11:30Z**, spanning the merge window.

---

## 10. What was NOT verified

Stated plainly, because the record above is otherwise easy to over-read:

1. **No production E2E verification.** Nothing in this record establishes that
   the Dashboard or Digital Twin renders correctly in a browser against the
   merged warehouse.
2. **No LINE verification.** The LINE authentication flow remains unverified end
   to end.
3. **No browser E2E verification.**
4. **The Airflow restart trigger is undetermined** (§7).
5. **The reason the row-count ฿/cycle moved to ฿48.40 was not established.**
   **RESOLVED 2026-09-30 12:45 UTC — see §5A. The attribution hypothesis is
   CONFIRMED:** the recovered days are 72.6929% unattributed against the
   complement's 61.7752%, and the move is a **row-mix** effect, not a price
   effect (revenue per unattributed paid/finished row is 6,306 satang vs
   6,273.4). At the complement's attribution mix the same data reads ฿43.05.
   **What this does not do is re-confirm the cycle-KPI decision** — the
   ฿/cycle agreement is now explained as an artefact of which rows carry
   attribution, so the decision is **weaker**, not stronger.
6. **Most §5 and §5A figures have no captured output file.** They come from
   read-only `SELECT` passes whose results are recorded here but written
   nowhere durable, so they are re-measurable but not re-readable (§6).

The health evidence in §9 is endpoint-level and scheduler-level only. It is
consistent with a successful merge; it is not a functional test of the product.
