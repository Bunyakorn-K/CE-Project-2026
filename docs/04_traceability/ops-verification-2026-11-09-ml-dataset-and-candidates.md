# R09 — the ML guide is correct, the dataset exists, and no candidate beats the baseline enough to adopt

**Date:** 2026-11-09
**Files:** `docs/06_ml/ml-training-data-guide.md` §4.1 §5.3 §9.1,
`apps/etl/src/ml-features.ts`, `apps/etl/src/ml-features-run.ts`,
`apps/etl/src/schema.ts`, `apps/etl/test/ml-features.test.ts`,
`docs/06_ml/compare_hourly_cycles.py`
**Status: guide corrected from measurements; dataset built in production; four
candidates compared on a fixed split; decision: do not adopt.**

## 1. What the guide said, and what is true

Every ML document claimed the warehouse was **19 days short of the 90-day gate**
(71 days, measured 2026-09-30). Measured 2026-11-09 07:45 UTC with the app's own
`reader` credential:

| Fact | Value |
|---|---|
| usage rows | **13,455** |
| distinct business days | **110** |
| span | `2026-07-22` → `2026-11-09` (**111** days) |
| missing day | **`2026-07-27`** — the only one, and a genuine source gap |
| rows with NULL `started_at` | **631** (in no hour bucket, on no business day) |
| rows at the real branch | 13,454 (plus 1 at the `SANDBOX` placeholder branch) |
| rows without `machine_session_id` | **9,198 = 68.4 %** |
| machines in `dim_machine` (active) | 23 across 2 branches (19 at the real one) |

The gate released itself and nothing noticed. §5.3 and §9.1 now carry these
numbers with their measurement date, and §4.1 declares the hourly per-machine
schema that actually exists rather than a daily one nothing built.

## 2. The dataset, and the one rule it exists to enforce

`fact_ml_features` is now built by `apps/etl/src/ml-features.ts` and re-derivable
by one command that prints its own size:

```bash
pnpm --filter @laundrytwin/etl ml:features
```

First build against production, 2026-11-09:

```json
{"table":"fact_ml_features","window":{"from":"2026-07-22 00:00:00","to":"2026-11-10 00:00:00"},
 "rows":61272,"distinct_days":111,"distinct_machines":23,
 "rows_with_null_cycles":11112,"usage_rows_without_started_at_in_window":631}
```

Per branch, which is the number that matters:

| branch | rows | NULL cycles | first day | last day |
|---|---|---|---|---|
| `5e9611c1…` (the real branch) | 50,616 | **456** | 2026-07-22 | 2026-11-09 |
| `e9b98f78…` (no usage rows ever) | 10,656 | 10,656 | 2026-07-22 | 2026-11-09 |

**456 = 19 machines × 24 hours = exactly the `2026-07-27` gap day.** The rule
("an hour inside a day that reported no rows is unmeasured, not zero") and the
data agree, and the second branch is entirely NULL because it has never reported
a usage row — which is also true, and now visible instead of invisible.

The rows come from a spine of machines × hours LEFT JOINed to usage, not from a
`GROUP BY`; a `GROUP BY` can only emit hours that had rows, which is the shape
that turns a source gap into a demand collapse.

## 3. The comparison, and the decision

Fixed split, no shuffling: the last **14 days** (336 hours) held out, 2,328 hours
trained. The gap day is a real NaN in the series (24 hours) and is never filled:

```bash
python docs/06_ml/compare_hourly_cycles.py --csv hourly-cycles.csv --holdout-days 14
```

| candidate | MAE (cycles/h) | RMSE | MAPE (non-zero hours) |
|---|---|---|---|
| seasonal-naive (weekly, t−168 h) | **2.6042** | 3.6216 | 61.51 % |
| SARIMA(1,0,1)(1,0,1,24) | 2.6034 | 3.7287 | 60.22 % |
| Prophet (daily + weekly) | 2.5044 | 3.4510 | 61.45 % |
| gradient-boosted trees (calendar only) | **2.3990** | 3.3116 | 57.71 % |

Holdout: `2026-10-27 00:00` → `2026-11-09 23:00`; MAPE over the 275 hours with a
non-zero actual (a cycle count of 0 makes percentage error undefined, and saying
"61 %" without that is a number nobody can compare).

**Decision: do not adopt any candidate, and keep `get_off_peak_windows` as the
only model-facing output.**

Why, stated so it can be argued with:

- **The best candidate beats the baseline by 8 % MAE** (2.399 vs 2.604 — about
  0.2 cycles per hour on a series whose mean is ~2.6). That is not a margin worth
  a deployed model, a retraining story and a freshness story.
- **The gradient-boosted model has only calendar features.** It is a learned
  hour-of-week profile, i.e. a slightly better-dressed seasonal naive. Its 8 %
  is evidence that the profile is smooth, not that machine learning found
  structure; a lag-based GBM would need recursion over a 336-hour horizon, which
  is a different and weaker claim.
- **Prophet and SARIMA are within 4 % of the baseline** while costing a
  per-branch fit and a model to keep alive. At 110 days neither can estimate a
  yearly cycle, and both are being asked to hold a weekly shape that the baseline
  already holds.
- **One 336-hour holdout is one draw.** No rolling-origin evaluation was run
  (110 days gives too few origins to separate 8 % from noise), so the honest
  reading is "indistinguishable at this resolution", not "GBM wins".

## 4. Two caveats that cap any claim here

1. **68.4 % of usage rows carry no `machine_session_id`.** `cycle_count` is a
   row count by decision; it is not a count of identified sessions, and no
   feature derived from it may be presented as one. What is missing is
   attribution, not activity.
2. **The weather source is one effective series for both provinces** (TMD returns
   byte-identical values per province in a collection window). Any
   "weather impact" claim is weaker than it reads, and `avg_temperature_c` in
   `fact_ml_features` is that one series joined to a branch-day.

## 5. Operational notes

- **The table was created and filled as the ClickHouse `admin` credential**, not
  as `etl_writer`: `etl_writer` deliberately has no `SELECT` on fact tables
  (`AGENTS.md`: "no fact table grants it"), so the builder's read side cannot run
  as that user. The documented grant for the *DDL* half was still applied —
  `GRANT INSERT, CREATE TABLE ON laundrytwin_analytics.fact_ml_features TO
  etl_writer` — so the ETL's DDL pass can create it on a fresh warehouse.
  **A least-privilege builder credential (SELECT on facts + INSERT on this table
  only) is the next step and is not done.**
- Nothing is scheduled. There is no DAG and no timer; the command is the
  reproducibility guarantee, and a scheduled writer would need its own freshness
  statement.
- The comparison ran in a throwaway venv (`numpy 2.5.4`, `pandas 3.1.1`,
  `statsmodels 0.15.0`, `scikit-learn 1.9.1`, `prophet 1.5.0`), not in CI. That is
  a real gap: the numbers below cannot be re-derived by a clean checkout without
  that environment.
