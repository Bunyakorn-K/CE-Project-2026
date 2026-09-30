# Ops verification — `fact_temperature_sample` de-duplication migration (2026-09-30)

**Scope:** clear 1,503,920 duplicate sort keys from
`laundrytwin_analytics.fact_temperature_sample`, and make the table idempotent
so they cannot come back. Production data migration; run with the ETL held
still.

**Status: applied and verified.** 3,762,139 rows → **2,258,219**, losslessly.
The pre-migration table is retained as `fact_temperature_sample_pre_dedup` and
is the rollback target.

---

## 1. What was actually wrong

### 1.1 The table had no de-duplication, and the watermark was the only guard

`fact_temperature_sample` was a plain `MergeTree`. `apps/etl/src/run.ts` inserts
a batch and **only then** advances the watermark file. A run that died between
those two steps therefore resumes from the old cursor on the next cycle and
re-inserts everything from there — permanently, because there was no engine
level to converge them.

`run.ts` documented this honestly, as a known single point of failure:

> *fact_temperature_sample is a plain MergeTree … so re-reading a temperature
> row inserts a second copy: the temperature read must not re-read a window it
> has already loaded.*

It did re-read. The ETL loop is `sleep 300`.

### 1.2 The shape of the damage

| Measurement (2026-09-30, production) | Value |
|---|---|
| Rows | 3,762,139 |
| Distinct `(tenant_id, branch_id, occurred_at, event_id)` | 2,258,219 |
| Duplicate sort keys | **1,503,920** |
| Worst single sample | **82 copies, 82 distinct `extracted_at`**, over **6h49m** (2026-09-18 19:08 → 2026-09-19 01:57) |
| Distinct days | 126, unchanged by the migration |

6h49m at the ETL's 5-minute cadence is ~82 cycles. That is the loop: every
cycle re-read the same tail and inserted it again.

By month, the damage is two separate regimes, not one:

| Month | Rows | Distinct keys | Duplicates | Distinct `extracted_at` |
|---|---|---|---|---|
| 2026-05 | 151,514 | 75,752 | 75,762 | 2 |
| 2026-06 | 1,014,254 | 507,048 | 507,206 | 2 |
| 2026-07 | 1,572,774 | 786,333 | 786,441 | 2 |
| 2026-08 | 673,972 | 542,464 | 131,508 | 491 |
| 2026-09 | 349,625 | 346,622 | 3,003 | 4,741 |

May–July is a clean **2×**: every key written exactly twice, in exactly two
extractions — one full re-read of an already-loaded period. August onwards is
the crash-and-retry signature with high multiplicity.

**Duplication stopped on 2026-09-26.** 2026-09-26 through 2026-09-29 have zero
duplicate sort keys, which lines up with the 2026-09-29 fix that re-keyed the
temperature keyset from `ingested_at` to `occurred_at` after a four-day ETL
hang. The 1.5M rows are a historical artefact of a bug that is already fixed —
but nothing stopped it recurring, because the table still had no safety net.

### 1.3 Three candidate causes, ruled out by measurement

Before concluding "the ETL re-reads its own tail", the two obvious alternatives
were checked against IRIS Postgres:

| Hypothesis | Verdict | How |
|---|---|---|
| The `machine` JOIN fans out (two branches with a machine on the same modbus address) | **Ruled out** | No two `machine` rows share `(kind, modbus_address)`; the join produces exactly **1** row per source row across all 1,688,495 joined rows |
| The keyset tuple is not unique, so a page can re-emit a row | **Ruled out** | In the source, `(occurred_at, seq, event_id)` is unique (1,688,497 rows = 1,688,497 distinct), `event_id` alone is unique, and every `(occurred_at, seq)` group has exactly **1** member — there is never a tie for the keyset to get wrong |
| The ETL re-read a window it had already loaded | **Confirmed** | The 82-copy sample carries 82 distinct `extracted_at` over exactly the ETL's cycle count |

### 1.4 The duplicates were harmless to the measurement, and not harmless to a reader

For **100%** of the 1,502,866 duplicated keys, `machine_id`, `seq`, `frame_seq`,
`temperature_f`, `temperature_c`, `phase` and `ingested_at` were identical
across every copy. The **only** column that ever varied was `extracted_at`, and
it took exactly 2 distinct values per key. So no reading was ever contradicted
by another — collapsing loses no measurement.

What it did corrupt was the analytics temperature curve, which is the only
reader of this table in the app. Measured on 2026-09-30 over 2026-09-22..26:

| Query | Rows returned | Distinct readings | Drawn twice |
|---|---|---|---|
| Old engine, no `FINAL` (what the app ran) | 35,486 | 34,169 | **1,317** |
| New engine, `AS s FINAL` (shipped) | 34,169 | 34,169 | **0** |

The same 1,317 also inflated `totalCount`, which the API surfaces as
`meta.truncation.totalRowsInRange`. So this was a user-visible defect, not
merely untidy storage.

## 2. Why the engine had to change, not just the query

The obvious cheaper fix — add `FINAL` to the curve query — is impossible
against the table as it stood:

```text
Code: 181. DB::Exception: Storage MergeTree doesn't support FINAL. (ILLEGAL_FINAL)
```

So the migration and the query fix are the same change, in that order. The
table now matches every other fact table in the warehouse.

**A mistake worth recording.** The first version of the query fix was written
`FROM fact_temperature_sample FINAL AS s`. The three unit tests added with it
passed — they regex-matched the token in the string I had just written, and
never ran the SQL. Only running it against the production server surfaced
`Syntax error … Expected alias cannot be here. (SYNTAX_ERROR)`: `FINAL` belongs
**after** the alias (`AS s FINAL`). The tests were rewritten to assert the whole
clause and to reject the invalid ordering, and the comment now records why.
A test that asserts the shape of code you have not executed is a test of your
memory, not of the database.

## 3. The constraint that ruled out the easy fix

A reload from IRIS would have been simpler. It would also have destroyed data.

The warehouse spans **2026-05-26 → 2026-09-29**. The IRIS
`machine_temperature_sample` table now starts at **2026-07-01** and holds
1,688,497 rows. The warehouse holds **2,258,219** distinct keys — more than the
source has rows.

So roughly two months of temperature history exist **only in ClickHouse**.
Any fix that rebuilds from the source deletes it. The migration was therefore
constrained to an in-place collapse of the warehouse itself, which is why the
dedup runs as a `GROUP BY` with `argMax` over the existing table and never
touches Postgres.

`argMax(<column>, extracted_at)` is used rather than a bare `GROUP BY` on the
sort key, so the result is deterministic **and** matches `ReplacingMergeTree`
semantics: if two copies ever did disagree on a reading, the most recent
extraction wins. Measured content mismatches after the collapse: **0**.

## 4. What was run

ETL held still throughout (`docker stop laundrytwin-etl-1`, verified stopped
before anything else; the hold window was ~15 seconds against a 5-minute ETL
cadence).

1. Snapshot rows and distinct keys **in one query**, so the comparison is at a
   single instant. This matters: the first dry run reported 2,258,219 while an
   earlier separate query had said 2,257,965, purely because the ETL was still
   writing between the two statements.
2. `CREATE TABLE fact_temperature_sample_v2` — same columns, same
   `PARTITION BY` and `ORDER BY`, engine `ReplacingMergeTree(extracted_at)`.
3. `INSERT INTO …_v2 SELECT … argMax(…) … GROUP BY tenant_id, branch_id,
   occurred_at, event_id`. Took 11s.
4. Verify, and **abort without swapping** on any mismatch:
   - v2 row count == snapshot distinct key count — `2,258,219` == `2,258,219`
   - every v2 row matches the source reading for its key — **0** mismatches
   - distinct day buckets unchanged — **126** == **126**
5. `RENAME TABLE fact_temperature_sample TO fact_temperature_sample_pre_dedup,
   fact_temperature_sample_v2 TO fact_temperature_sample` — atomic.
6. Re-apply the `etl_writer` grants, revoke the grant left pointing at the old
   `…_v2` name, restart the ETL.

## 5. Post-change verification

| Check | Result |
|---|---|
| Engine | `ReplacingMergeTree(extracted_at)` |
| `PARTITION BY` / `ORDER BY` | `toYYYYMM(occurred_at)` / `(tenant_id, branch_id, occurred_at, event_id)` — unchanged |
| Rows == `FINAL` rows | 2,258,219 == 2,258,219 (already converged) |
| Span | 2026-05-26 15:51:50.633 → 2026-09-29 13:43:04.962 — preserved |
| Day buckets | 126 — preserved |
| Retained rollback table | `fact_temperature_sample_pre_dedup`, 3,762,139 rows |
| `etl_writer` grants | `INSERT, CREATE TABLE` on the new table |
| ETL | restarted, `restarts=0`, clean run: `2 branches, 23 machines, 3 usages, 59 temperature samples` |

## 6. Rollback

```sql
RENAME TABLE fact_temperature_sample TO fact_temperature_sample_dedup,
             fact_temperature_sample_pre_dedup TO fact_temperature_sample;
```

Then re-point `apps/etl/src/schema.ts` and `apps/api/src/analytics/queries.ts`
back and revert the migration commit. Note that rolling back reinstates the
non-idempotent engine, so the duplicate-generating crash mode returns with it.

`fact_temperature_sample_pre_dedup` is **not** dropped by this migration. It is
only removed once the deduplicated table has been observed across a few days of
ETL cycles.

## 7. What still needs doing

- **The crash mode is hardened but not designed out.** `ReplacingMergeTree`
  makes a re-read converge, so a repeat is now harmless — but a run that dies
  between the insert and the watermark save still burns a full re-read, and the
  watermark still stalls. The log-only guard from 2026-09-29 catches a slow
  phase; it does not make the two writes atomic, and on a single-node ClickHouse
  they cannot be. Accept the at-least-once read and rely on the engine, or move
  the watermark into the warehouse. This is a design decision, not a bug.
- **`fact_temperature_sample_pre_dedup` costs ~125 MiB** and should be dropped
  after a few days of clean ETL cycles.
- **Re-check the API's other count surfaces.** The curve's `totalCount` was
  measured; any other query counting this table was not.
