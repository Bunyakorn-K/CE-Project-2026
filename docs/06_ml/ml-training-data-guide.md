# 🧠 ML Training Data & Feature Engineering Guide

**Document Purpose:** Define the schema, features, and data pipeline for training ML models on LaundroTwin usage + weather data. This document is the single source of truth for anyone building a predictive model on this warehouse.

**Created:** 2026-09-22
**Data source:** ClickHouse `laundrytwin_analytics` on VM 117

---

## 1. Overview

We train models to predict **off-peak usage windows** (hour-of-day × day-of-week) for laundromat branches. The primary ML use case is recommending when to run promotions.

| Model phase | Target | Data requirement | Status |
|---|---|---|---|
| **Phase A — Baseline** | Percentile heuristic | None (rule-based) | ✅ Done |
| **Phase B — Evaluation** | Offline metric on historical window | ≥ 1 week continuous data | ✅ Deployed |
| **Phase C — Model candidate** | Prophet / SARIMA / Gradient Boosting | ≥ 3 months continuous data | ⏳ Future |
| **Phase D — Promotion effect** | A/B measurement | Operations buy-in | ⏳ Future |

**Current data reality:** ~4.8k usage rows (as of 2026-09-07), ~1 week of a single busy branch. **Far too little for robust time-series modeling.** Any model fitted today would overfit. State data volume in every output.

---

## 2. Data Sources

### 2.1 Core tables

| Table | Engine | Key | Purpose |
|---|---|---|---|
| `fact_machine_usage` | ReplacingMergeTree | `(tenant_id, branch_id, usage_id)` | Raw usage events (cycles, duration, revenue, program) |
| `fact_weather_sample` | ReplacingMergeTree | `(tenant_id, branch_id, timestamp)` | TMD NWP hourly forecast (temp, humidity, rain, condition) |
| `dim_branch` | ReplacingMergeTree | `(tenant_id, branch_id)` | Branch metadata (name, timezone, active) |
| `dim_branch_location` | ReplacingMergeTree | `(tenant_id, branch_id)` | Location info (province, sub_district, district, lat, lon) |
| `fact_temperature_sample` | MergeTree (monthly partition) | `(tenant_id, branch_id, occurred_at, event_id)` | Machine temperature readings |

### 2.2 Feature tables (derived)

| Table | Engine | Key | Purpose |
|---|---|---|---|
| `fact_weather_daily` (planned) | ReplacingMergeTree | `(tenant_id, branch_id, date)` | Aggregated daily weather features for ML |
| `fact_usage_daily` (planned) | ReplacingMergeTree | `(tenant_id, branch_id, date)` | Aggregated daily usage features for ML |

---

## 3. Feature Engineering

### 3.1 Usage features (from `fact_machine_usage`)

Every row in `fact_machine_usage` represents one machine session. For ML, aggregate per `(branch_id, hour_of_day, day_of_week, date)`.

| Feature name | Type | SQL expression | Description |
|---|---|---|---|
| `cycle_count` | UInt64 | `countIf(status IN ('finished', 'paid'))` | Number of completed sessions |
| `total_duration_min` | UInt64 | `sum(duration_min)` | Total minutes of usage |
| `total_revenue_satang` | Int64 | `sum(amount_satang)` | Total revenue in satang |
| `avg_duration_min` | Float64 | `avg(duration_min)` | Average session duration |
| `unique_machines` | UInt64 | `count(DISTINCT machine_id)` | Number of machines used |
| `paid_ratio` | Float64 | `countIf(status='paid') / countIf(status IN ('finished','paid'))` | Fraction of paid sessions |

### 3.2 Weather features (from `fact_weather_sample`)

TMD NWP returns hourly forecasts. For ML, aggregate to `(branch_id, date)`.

| Feature name | Type | SQL expression | Description |
|---|---|---|---|
| `avg_temp_c` | Float64 | `avg(weather_temp_c)` | Mean temperature (°C) |
| `avg_humidity_pct` | Float64 | `avg(weather_humidity_pct)` | Mean relative humidity (%) |
| `total_rain_mm` | Float64 | `sum(weather_rain_mm)` | Total precipitation (mm) |
| `max_temp_c` | Float64 | `max(weather_temp_c)` | Peak temperature |
| `min_temp_c` | Float64 | `min(weather_temp_c)` | Lowest temperature |
| `rain_hours` | UInt64 | `countIf(weather_rain_mm > 0)` | Number of hours with rain |
| `avg_cond` | Float64 | `avg(weather_cond)` | Mean TMD condition code |

**Note:** `sub_district` and `district` in `fact_weather_sample` are currently `NULL`. When populated, they can be used as additional categorical features.

### 3.3 Temporal features

| Feature name | Type | Description |
|---|---|---|
| `hour_of_day` | UInt8 | 0–23, Asia/Bangkok local time |
| `day_of_week` | UInt8 | 0=Monday, 6=Sunday |
| `is_weekend` | UInt8 | 0 or 1 |
| `month` | UInt8 | 1–12 |
| `is_holiday` | UInt8 | 0 or 1 (Thai holiday calendar) |
| `season` | String | 'wet' / 'hot' / 'cool' (Thai seasons) |

### 3.4 Branch features (from `dim_branch` + `dim_branch_location`)

| Feature name | Type | Description |
|---|---|---|
| `branch_name` | String | Display name |
| `province` | String | Thai province name |
| `sub_district` | Nullable(String) | Currently NULL |
| `district` | Nullable(String) | Currently NULL |
| `lat` | Float64 | Latitude |
| `lon` | Float64 | Longitude |
| `timezone` | String | Usually 'Asia/Bangkok' |
| `active` | UInt8 | 0 or 1 |

### 3.5 Derived interaction features (for model training)

| Feature name | Type | Description |
|---|---|---|
| `temp_x_hour` | Float64 | `avg_temp_c * hour_of_day` |
| `humidity_x_weekend` | Float64 | `avg_humidity_pct * is_weekend` |
| `rain_x_is_weekend` | Float64 | `total_rain_mm * is_weekend` |

---

## 4. Training Data Schema

### 4.1 Final training dataset (`fact_ml_features`)

One row per `(branch_id, date)`. This is the denormalized training table.

```sql
CREATE TABLE laundrytwin_analytics.fact_ml_features (
    tenant_id UUID,
    branch_id UUID,
    date Date,
    -- Usage features
    cycle_count UInt64,
    total_duration_min UInt64,
    total_revenue_satang Int64,
    avg_duration_min Float64,
    unique_machines UInt64,
    paid_ratio Float64,
    -- Weather features
    avg_temp_c Float64,
    avg_humidity_pct Float64,
    total_rain_mm Float64,
    max_temp_c Float64,
    min_temp_c Float64,
    rain_hours UInt64,
    avg_cond Float64,
    -- Temporal features
    hour_of_day UInt8,
    day_of_week UInt8,
    is_weekend UInt8,
    month UInt8,
    is_holiday UInt8,
    season String,
    -- Branch features
    province String,
    sub_district Nullable(String),
    district Nullable(String),
    lat Float64,
    lon Float64,
    -- Interaction features
    temp_x_hour Float64,
    humidity_x_weekend Float64,
    rain_x_is_weekend Float64,
    -- Target (for supervised learning)
    target_low_usage UInt8  -- 1 if bottom tercile, 0 otherwise
) ENGINE = ReplacingMergeTree
ORDER BY (tenant_id, branch_id, date);
```

### 4.2 Target definition

`target_low_usage = 1` when `total_duration_min` is in the bottom tercile for that `(branch_id, day_of_week)` group within the training window. This is the label for off-peak detection.

---

## 5. Data Collection Pipeline

### 5.1 Hourly collection (current)

The `laundrytwin-weather-1` container runs `weather-run.ts` every 1 hour (`sleep 3600`). It:
1. Queries `dim_branch_location` JOIN `dim_branch active=1` for targets
2. Fetches TMD NWP hourly forecast for each province
3. Inserts into `fact_weather_sample`

### 5.2 Daily aggregation (for ML)

Generate `fact_ml_features` with a scheduled query:

```sql
-- Run daily at 01:00 Asia/Bangkok
INSERT INTO laundrytwin_analytics.fact_ml_features
WITH usage_daily AS (
    SELECT
        branch_id,
        toStartOfDay(started_at) AS date,
        countIf(status IN ('finished', 'paid')) AS cycle_count,
        sum(duration_min) AS total_duration_min,
        sum(amount_satang) AS total_revenue_satang,
        avg(duration_min) AS avg_duration_min,
        count(DISTINCT machine_id) AS unique_machines,
        countIf(status='paid') / countIf(status IN ('finished','paid')) AS paid_ratio
    FROM fact_machine_usage FINAL
    WHERE started_at >= today() - INTERVAL 90 DAY
    GROUP BY branch_id, date
),
weather_daily AS (
    SELECT
        branch_id,
        toDate(timestamp) AS date,
        avg(weather_temp_c) AS avg_temp_c,
        avg(weather_humidity_pct) AS avg_humidity_pct,
        sum(weather_rain_mm) AS total_rain_mm,
        max(weather_temp_c) AS max_temp_c,
        min(weather_temp_c) AS min_temp_c,
        countIf(weather_rain_mm > 0) AS rain_hours,
        avg(weather_cond) AS avg_cond
    FROM fact_weather_sample FINAL
    WHERE timestamp >= now() - INTERVAL 90 DAY
    GROUP BY branch_id, date
)
SELECT
    u.tenant_id,
    u.branch_id,
    u.date,
    u.cycle_count,
    u.total_duration_min,
    u.total_revenue_satang,
    u.avg_duration_min,
    u.unique_machines,
    u.paid_ratio,
    w.avg_temp_c,
    w.avg_humidity_pct,
    w.total_rain_mm,
    w.max_temp_c,
    w.min_temp_c,
    w.rain_hours,
    w.avg_cond,
    -- Temporal features
    toHour(u.date) AS hour_of_day,  -- placeholder, actual = from usage
    -- NOTE: Temporal features come from the date itself, not usage
    ...
FROM usage_daily u
LEFT JOIN weather_daily w ON u.branch_id = w.branch_id AND u.date = w.date;
```

### 5.3 Data volume requirements

| Model | Minimum data | Recommended data | Current status |
|---|---|---|---|
| Heuristic baseline | None | Any | ✅ Done |
| ARIMA / SARIMA | 90 days daily | 180+ days | ⏳ ~1 week |
| Prophet | 90 days daily | 365+ days | ⏳ ~1 week |
| Gradient Boosting | 90 days + features | 365+ days | ⏳ ~1 week |

---

## 6. Feature List for Models

### 6.1 Core features (all models)

```
[cycle_count, total_duration_min, total_revenue_satang, avg_duration_min,
 avg_temp_c, avg_humidity_pct, total_rain_mm, max_temp_c, min_temp_c,
 rain_hours, is_weekend, month, is_holiday, province]
```

### 6.2 Enhanced features (gradient boosting models)

```
[core_features +
 hour_of_day, day_of_week, season,
 temp_x_hour, humidity_x_weekend, rain_x_is_weekend,
 lat, lon, unique_machines, paid_ratio]
```

### 6.3 Weather-only features (for weather-impact analysis)

```
[avg_temp_c, avg_humidity_pct, total_rain_mm, max_temp_c, min_temp_c,
 rain_hours, avg_cond, is_weekend, month]
```

---

## 7. Model Training Plan

### Phase A — Baseline (DONE)

- **Method:** Percentile heuristic
- **Features:** None (rule-based)
- **Output:** `get_off_peak_windows` MCP tool
- **Algorithm:** Bucket by `(hour × weekday)`, rank by utilization, return bottom N
- **Evidence:** `docs/06_ml/algorithm-comparison.md`

### Phase B — Evaluation Harness

1. Export `fact_ml_features` for last 7 days
2. Split: 80% train / 20% validation (temporal split — no future data in train)
3. Baseline: predict bottom tercile from historical percentile
4. Metric: **Hit-rate@k** (% of true low-usage hours in top-k recommendations)
5. Freeze a test window for future comparison

### Phase C — Model Candidate

**Candidate 1: Prophet**
- Pros: Handles seasonality + holidays, robust to gaps
- Cons: Single-series only (one model per branch), no exogenous features
- Input: `total_duration_min` per `(branch_id, date)`
- Features: weekly + yearly seasonality, Thai holidays

**Candidate 2: SARIMA**
- Pros: Classic, interpretable, per-branch
- Cons: Needs 90+ days, fragile with sparse data
- Input: `cycle_count` per `(branch_id, date)`

**Candidate 3: Gradient Boosting (XGBoost / LightGBM)**
- Pros: Fuses weather + temporal + branch features
- Cons: Needs labeled outcomes, per-branch or global model
- Input: `fact_ml_features` rows
- Features: Section 6.2

### Phase D — Promotion Effect Measurement

- **Method:** A/B test
- **Metric:** Utilization lift during promoted windows vs baseline
- **Requirement:** Operations buy-in for real promotions

---

## 8. Evaluation Metrics

| Metric | Definition | Decision Use |
|---|---|---|
| **Hit-rate@k** | % of true low-usage hours in top-k recommendations | Ranking quality |
| **MAE (daily usage)** | Mean abs error of predicted total duration per day vs actual | Forecast accuracy |
| **Utilization lift** | % change in utilization during promoted windows vs baseline | Business success |
| **Coverage/fallout** | Promoted hours that turned out busy (false positives) | Trust in recommendation |

**Report all four, never MAE alone — Phase 2 decisions are business decisions.**

---

## 9. Constraints & Caveats

### 9.1 Data limitations

- **Province duplication:** TMD hourly returns byte-identical temp/rh/rain for all Thai provinces in the same collection window. Per-province weather curves need a location-specific source (lat/lon + station code).
- **Sample size:** ~4.8k usage rows (as of 2026-09-07). Any model fitted today would overfit.
- **Weather-source limitation:** TMD NWP is a forecast, not observations. Correlation ≠ causation.

### 9.2 R12 compliance

- All ML outputs must state the source data range
- Never imply causation or forecast accuracy without validation
- Always append the fixed caveat: *"Values are based on correlation analysis of historical data, not causal inference or predictive modeling."*

### 9.3 Security

- `TMD_API_KEY` is server-side only (env var) — never sent to browser
- `CLICKHOUSE_PASSWORD` is server-side only
- No customer PII is used — bucket aggregates only
- `fact_ml_features` contains no personally identifiable information

---

## 10. File References

| File | Purpose |
|---|---|
| `apps/etl/src/weather.ts` | TMD collector → `fact_weather_sample` |
| `apps/etl/src/weather-run.ts` | CLI entry point for weather collection |
| `apps/etl/src/schema.ts` | ClickHouse table schemas |
| `apps/api/src/analytics/mcp.ts` | Allow-listed MCP tools (baseline) |
| `docs/06_ml/algorithm-comparison.md` | Algorithm comparison & development plan |
| `docs/03_data_contracts/data_contracts.md` | Data contract rules |
| `docs/04_traceability/RTM_matrix.md` | Requirement traceability |
| `docs/04_traceability/f12-weather-evaluation-2026-09-07.md` | Weather correlation evaluation |

---

## 11. Maintenance Rules

- Re-evaluate model candidates when `fact_machine_usage` has ≥ 90 days of continuous data (quarterly)
- Re-check `fact_weather_sample` province duplication quarterly
- Update this document when new features are added or data sources change
- Never train on data that includes the target window (temporal split only)
