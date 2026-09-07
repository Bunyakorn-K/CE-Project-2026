# 🌦️ F-12 Weather–Usage Correlation — First Evaluation (2026-09-07)

**Function:** F-12 (External Context) · **Requirement:** R12 · **User story:** US-06
**Status:** Collector + warehouse + MCP tool live; correlation **not yet evaluable** on live data — see verdict below.

## What is deployed (evidence)

| Piece | Evidence |
|---|---|
| TMD hourly collector | `laundrytwin-weather-1` on VM 117, loop every 5 min (`commit 827aeb1`) |
| Warehouse table | `fact_weather_sample` (ReplacingMergeTree by `(province, timestamp)`) — live rows 2026-09-07 13:00–16:00, เชียงใหม่/ชลบุรี, 8 hourly points, dedup verified via `FINAL` |
| Superset chart | "Weather (TMD hourly)" — chart 8 on dashboard "LaundryTwin Analytics", dataset 9 (`fact_weather_sample`), metrics `avg_temp_c` / `avg_humidity_pct` / `total_rain_mm` |
| MCP analytics tool | `get_weather_usage_correlation` (allow-listed, RBAC-scoped) with fixed R12 caveat |
| Seed | `deploy/analytics/seed/laundrytwin-dashboards.zip` now includes the weather chart + dataset (password placeholder, bootstrap-compatible) |

## Correlation evaluation (honest verdict)

Ran the Pearson correlation (hourly weather vs. hourly wash cycles,
`status IN ('finished','paid')`) directly in ClickHouse over the collected
window:

| Province | n (hour pairs) | corr(temp, cycles) | corr(humidity, cycles) | corr(rain, cycles) |
|---|---|---|---|---|
| เชียงใหม่ | 4 | **NaN** | **NaN** | **NaN** |
| ชลบุรี | 4 | **NaN** | **NaN** | **NaN** |

**Why NaN:** the usage series and the weather series do not overlap —
fact_machine_usage for 2026-09-07 ends at 09:09 (the IRIS source itself has
no newer usage events; ETL is current — last successful run loaded 1 usage,
49 temperature samples), while weather collection began at 13:00 the same
day. With zero overlapping hours, `corr()` is undefined. This is not a bug;
it is the honest state of the data.

**Verdict (R12-compliant):** correlation is **not evaluable yet**. The TMD
hourly endpoint returns only a ~2–3 h forecast window per call, so the
weather series accumulates ~2–3 new points per pass; a meaningful
day-over-day evaluation needs at least 7–14 days of accumulation (the ML
plan in `docs/06_ml/algorithm-comparison.md` uses the same ≥3-month horizon
for modeling, ≥1 week for a first honest look).

## Re-evaluation procedure (repeat weekly)

1. Collect the hourly pairs per province:

```sql
WITH usage AS (
    SELECT toStartOfHour(started_at) AS hr,
           countIf(status IN ('finished', 'paid')) AS cycles
    FROM fact_machine_usage FINAL
    GROUP BY hr
),
weather AS (
    SELECT toStartOfHour(timestamp) AS hr, province,
           avg(weather_temp_c) AS t,
           avg(weather_humidity_pct) AS rh,
           sum(weather_rain_mm) AS rain
    FROM fact_weather_sample FINAL
    GROUP BY hr, province
)
SELECT province, count() AS n,
       round(corr(t, cycles), 4)   AS corr_temp,
       round(corr(rh, cycles), 4)  AS corr_humidity,
       round(corr(rain, cycles), 4) AS corr_rain
FROM weather w LEFT JOIN usage u ON u.hr = w.hr
GROUP BY province
```

2. Interpret under the R12 rules: report n and the value only when n ≥ ~24
   overlapping hours; always state the window; never imply causation or
   forecast. The MCP tool appends the fixed caveat automatically.

## Follow-ups

- [ ] Re-run the evaluation query after ~7 days of accumulation
- [ ] Add เชียงใหม่/ชลบุรี branch mapping if a per-branch weather curve is
      wanted (currently province-level)
- [ ] Re-export the seed after any chart tweak (keep `__CH_PASSWORD__`)
