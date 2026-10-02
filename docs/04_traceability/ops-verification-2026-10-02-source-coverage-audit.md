# Source-vs-warehouse coverage audit — 2026-10-02

**Question asked:** can the missing data be pulled from production, and can a
script handle the gaps?

**Answer: there is nothing to pull, and the gaps that exist cannot be filled by
any reload.** Both halves were measured against production on 2026-10-02, not
inferred. The deliverable is therefore a *classifier* (`apps/etl/src/coverage.ts`,
run by `coverage-audit.ts`), not a backfill — a backfill built on the
count-only diff it replaces would have inserted rows that cannot exist.

## The measurement that inverted the plan

A calendar diff of `fact_machine_usage` against the calendar reports **68
"missing" days** spanning `2026-04-28 … 2026-07-21` (423 rows) and invites a
backfill. Every one of those days is a mirage:

| fact | measured value |
|---|---|
| IRIS usage rows dated before the warehouse's first business day | **424** |
| …of those, rows carrying `started_at` | **0** |
| first day IRIS ever populated `started_at` | **2026-07-22** |
| warehouse first business day, `min(toDate(started_at))` | **2026-07-22** |

`fact_machine_usage` is keyed on **`started_at`** — the business day the row is
*about* — while the ETL cursor is keyed on **`created_at`** — when the row
*arrived* (`apps/etl/src/run.ts:271`). Every pre-`2026-07-22` IRIS row is a
dispatch that never started a cycle, so it carries no business timestamp and can
never appear on the business timeline at any load factor. The two dates being
*identical* is the real result: **the warehouse's first business day is exactly
the first day the source could produce one.** There is no day the source could
have supplied and the ETL failed to load.

The ETL had already done the work — IRIS 8,247 rows vs warehouse 8,248 `FINAL`.

## The audit, run against production

```
warehouse: 72 business days (2026-07-22 .. 2026-10-02)
source:    73 created-days, 72 carrying started_at
2026-07-22 .. 2026-10-02 · 72/73 days present · 0 recoverable ·
  1 without a business timestamp · 0 absent from source

NOT A BUSINESS DAY — source has rows but none carry started_at:
  2026-07-27
```

Exit code **0** — nothing recoverable, so nothing to alert on. Production
ClickHouse `26.3.26.3`, engine read with the app's own `reader` credential; the
ETL's `etl_writer` was tried first and refused, which is the grant design working
(`SELECT` is deliberately not granted on fact tables).

### Window policy is part of the finding

The first run overrode `COVERAGE_FROM=2026-04-28` and reported **18 "absent from
source" days** in April–June. All 18 were days *before the source's oldest row* —
the same false-gap class the audit exists to prevent, manufactured by the
window rather than by the data. So the default window is now the **intersection**
of the warehouse span and the source span (`firstUsageDay()`), and an explicit
override is clamped to it and says so. A reversed or non-overlapping window
exits 0 with an explanation rather than a clean bill of health for a window it
never examined.

## Finding 1 — `2026-07-27` is exempted for a reason that is factually wrong

`deploy/analytics/dags/laundrytwin_warehouse_freshness.py:59` states:

> Measured 2026-09-30: 2026-07-27 has no usage rows in IRIS either.

IRIS holds **5 rows** for that day. Measured directly:

| status | rows | carrying `started_at` |
|---|---|---|
| `cancelled` | 5 | **0** |

**The conclusion is right and the evidence is wrong.** No usage row is
*recoverable* — the five are cancelled dispatches with no business timestamp —
but "no rows in IRIS either" is not what IRIS holds, and an exemption justified
by a fact that is false is one that will not be re-measured when it stops being
load-bearing. The audit reclassifies the day as **`no_business_timestamp`**, the
verdict a count-only diff cannot produce, and that is now the recorded reason.

Corrected comment in place; the exemption list itself is unchanged (still one
day, still evidence-backed).

## Finding 2 — `2026-06-17` temperature gap is real, permanent, and unchecked

| series | span | holes |
|---|---|---|
| `fact_temperature_sample` | 2026-05-26 … 2026-10-01 (128 days) | **`2026-06-17`** |
| `fact_machine_usage` | 2026-07-22 … 2026-10-02 (72 days) | `2026-07-27` |
| shared window (72 days) | 2026-07-22 … 2026-10-01 | usage-but-no-temperature: **none** |

`2026-06-17` was already identified in
`ops-verification-2026-09-30-warehouse-data-recovery.md` §4. What was not
recorded is that it **can never be filled**: IRIS holds temperature only from
**`2026-07-01`** (1,710,818 rows, `earliest 2026-07-01`, `latest 2026-10-02`) —
IRIS applies retention that the warehouse does not, so the source has no rows
for any day the warehouse's early temperature range covers. A reload cannot
recover it because the rows no longer exist upstream.

It is also **covered by no check**, in a way that is structural rather than
accidental:

- `check_usage_continuity` inspects `fact_machine_usage` only.
- `check_temperature_freshness` measures `dateDiff('minute', max(extracted_at),
  now())` — an *age*. A hole in the middle of the history leaves `max()` exactly
  where it was, so a permanently unfillable gap is invisible to it forever.

So the one genuinely lost day in the temperature series has no detector, and the
detector that sounds like it would cover temperature cannot see it. Left as a
recorded finding rather than a code change: adding a temperature continuity
check is a scope decision, and the right shape is a second
`check_*_continuity` with its own evidence-backed exemption list — not a
threshold tweak on the freshness age.

## What was not done, deliberately

- **No backfill was written.** The measurement says there is nothing to backfill;
  a script that inserted the 424 pre-`2026-07-22` rows would either be inert or
  would corrupt the business timeline.
- **No production state was changed.** Every query was `SELECT`. The audit ran
  from a scratch copy inside the ETL container; the deployed ETL code was never
  modified, and `src-audit/` was removed afterwards.
- **No DAG was edited beyond the one comment correction.** Changing alerting
  behaviour is a scope decision, not a finding.

## Evidence

- `apps/etl/src/coverage.ts` — the classifier (pure, 13 tests)
- `apps/etl/src/coverage-audit.ts` — the read-only runner, exits 1 only on a
  genuinely recoverable gap
- `apps/etl/src/postgres.ts` — `firstUsageDay()` + the two audit views
- Full suite 2026-10-02: **858 green** (API 485, web 268, ETL 105 — ETL up from
  87). `pnpm check` clean.
- Guards verified to fail against deliberately broken code: dropping the
  inclusive upper bound; keying the `started_at` view on `created_at` (which
  collapses the distinction the audit exists for).
