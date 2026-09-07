# 📈 ML Recommendation — Algorithm Comparison & Plan (Epic 4 · #35)

**Purpose:** decide the algorithm for "off-peak promotion window" detection
(US-06, R09 — Phase 2), with a development plan and evaluation metrics. This
is a research/planning document; no ML model ships in the MVP.

**Data reality check (2026-09-06):** the warehouse holds ~4.3k usage rows over
a short period (a few days of real data + demo). That is **far too little for
a robust time-series model** — the honest recommendation below therefore
starts with a rule-based baseline and treats statistical models as candidates
to revisit once ≥ 3 months of history exist.

## 1. Problem definition

- **Goal:** given historical usage per branch, return off-peak windows
  (hour-of-day × day-of-week buckets) suitable for promotions, with the rules
  and data range stated (US-06 acceptance).
- **Not a forecasting problem first:** it is a *ranking* problem over time
  buckets. Forecasting (rainy-day demand shift) is out of scope for Phase 2.
- **Constraints from R09:** recommendations must specify branch, timeframe,
  metric, and the rules used — traceability beats model cleverness.

## 2. Candidates

| Approach | Strengths | Weaknesses | Fit now |
| :------- | :-------- | :--------- | :------ |
| **Heuristic percentile baseline** | Explainable, no training data needed, works at any data volume; the bucket rules are the recommendation | Not adaptive to trends/shifts | ✅ **Recommended baseline** |
| ARIMA / SARIMA (per branch-series) | Classic, interpretable, good with long stable series | Needs long history (≥ 90d daily series), fragile with sparse data, per-branch fits | ⏳ revisit at ≥ 3 months data |
| Prophet | Trend/seasonality + holiday effects, robust to gaps | Overkill for 24×7 bucket ranking; holiday list for Thai calendar needs curation | ⏳ revisit |
| Simple ML ranker (gradient boosting on bucket features) | Can fuse weather + branch + holiday features | Needs labeled outcomes + validation split we don't have yet | ⏳ revisit |

### Baseline (recommended now)

For each branch: bucket usage by `(hour, weekday)`, compute `total_duration_min`
and `cycle_count`, then rank buckets by the *lowest* utilization; return the
bottom N buckets with:

- the percentile rule used (e.g., bottom 25% of buckets, min 10 cycles in the
  window to avoid empty-noise buckets),
- the exact bucket list, and
- the data range + caveat that this is descriptive, not predictive.

This can be a **parameterized, allow-listed analytics function** (same shape as
the existing MCP tools), so the assistant can answer "when should I run a
promotion?" without any ML infra.

## 3. Development plan (phases)

1. **Phase A — baseline (next):** implement `get_off_peak_windows` as an
   allow-listed analytics function (ClickHouse query over `fact_machine_usage`
   + `dim_branch`), RBAC-scoped, output = ranked buckets + rules + caveat.
2. **Phase B — evaluation harness:** collect weekly usage exports into a
   golden dataset; define the offline metric below; freeze a test window.
3. **Phase C — model candidate:** once ≥ 3 months of history exist, fit
   Prophet/SARIMA per branch and compare against the baseline on the frozen
   window. Promote the model only if it beats baseline on the business metric.
4. **Phase D — promotion effect measurement:** A/B on real promotions
   (Phase 2, requires operations buy-in) measuring utilization lift.

## 4. Metrics

| Metric | Definition | Decision use |
| :----- | :--------- | :----------- |
| **Hit-rate@k** | % of true low-usage hours (label: bottom tercile observed) present in the top-k recommended windows | ranking quality |
| **MAE (daily usage, model phase)** | mean abs error of predicted total duration per day vs actual | forecast accuracy when models are considered |
| **Utilization lift (business)** | % change in utilization during promoted windows vs baseline windows (A/B) | whether the feature works in practice |
| **Coverage/fallout** | promoted hours that turned out busy (false positives) | trust in the recommendation |

Report **all four**, never MAE alone — Phase 2 decisions are business
decisions, not just accuracy scores.

## 5. Risks / honest notes

- 4.3k rows ≈ 1 week of a single busy branch: any model fitted today would
  overfit. State data volume in every output (the envelope already carries
  `totalRows`).
- Weather correlation (F-12/#34) is descriptive; do not chain it into a
  demand forecast without validation.
- No customer PII is used; bucket aggregates only.

## Maintenance rules

- Re-evaluate the "revisit" candidates when `fact_machine_usage` has ≥ 90 days
  of continuous data (re-check quarterly).
- Every recommendation output must carry the data range + rules (R09).
