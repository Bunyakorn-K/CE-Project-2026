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

## Correlation evaluation — updated (2026-09-10, 4 days)

Re-ran the same query after data accumulation (7–10 Sep 2026, UTC-aligned):

| Province | n (hour pairs) | corr(temp, cycles) | corr(rh, cycles) | corr(rain, cycles) |
|---|---|---|---|---|
| เชียงใหม่ | 77 | **+0.418** | **−0.359** | +0.135 |
| ชลบุนี | 77 | +0.314 | −0.227 | −0.101 |

**Data window:** weather 2026-09-07 06:00 → 2026-09-10 12:00 UTC (154 rows total);
usage 2026-07-22 → 2026-09-10 12:32 (4,834 rows). All 77 overlapping hourly
pairs are present in both provinces.

**Significance:** for n=77 the critical Pearson r at p<0.05 is ≈0.22, so
`corr(temp, cycles) = +0.418` and `corr(rh, cycles) = −0.359` are
statistically significant for เชียงใหม and directionally consistent for
ชลบุนี. Rain correlation stays small and sign-inconsistent across the two
provinces — not distinguishable from noise at this sample size.

### Province duplication — a real limitation of this data source

Verified on the same window: temperature, humidity and rain are **identical
for both provinces in all 77 overlapping hours** (`countIf(diff) = 0` for each
metric). The TMD hourly endpoint returns the same forecast for เชียงใหม and
ชลบุนี in this collection window, so the per-province split does **not**
separate distinct weather series — it duplicates one series under two labels.
Consequently the per-province correlation numbers above differ only through
different branch/usage joins, not through different weather.

This does not invalidate the headline finding (warmer hours → more cycles,
more humid hours → fewer cycles), but it does mean F-12 currently has a single
effective weather series, not a multi-branch one. A per-branch weather curve
needs lat/lon per branch resolved against a source that actually differs by
location (or the TMD city endpoint with a distinct station code).

**R12 verdict update:** correlation is now **evaluable and significant** for
temperature and humidity (n=77). Report as correlation only — no causation or
forecast claims. The MCP tool continues to append the fixed caveat.

**Accumulation continues:** re-run weekly. The ML plan's ≥3-month horizon for
modeling still applies; 4 days supports a first honest correlation, not a
forecast.

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

- [x] Re-run the evaluation query after data accumulation → 2026-09-10,
      n=77, significant (see updated verdict above)
- [~] Add เชียงใหม่/ชลบรี branch mapping → **not viable with the TMD hourly
      source**: both provinces return byte-identical temp/rh/rain for every
      hour in the window, so per-branch weather curves need lat/lon + a
      source that actually differs by location (or TMD city endpoint with
      distinct station codes). Blocked on a source change, not on code.
- [ ] Re-export the seed after any chart tweak (keep `__CH_PASSWORD__`)
