-- Migrate fact_weather_sample: rows collected before the UTC fix (commit
-- 827aeb1-era collector) were stored as Asia/Bangkok wall-clock (the TMD
-- "+07:00" suffix was stripped but the local instant kept). The pipeline now
-- stores true UTC (see apps/etl/src/datetime.ts). Rewrite historical rows by
-- shifting -7h; ReplacingMergeTree keeps the latest version per
-- (province, timestamp), then OPTIMIZE drops the stale versions.

INSERT INTO fact_weather_sample
  (timestamp, province, weather_temp_c, weather_humidity_pct, weather_rain_mm, weather_cond)
SELECT
  timestamp - INTERVAL 7 HOUR AS timestamp,
  province,
  weather_temp_c,
  weather_humidity_pct,
  weather_rain_mm,
  weather_cond
FROM fact_weather_sample
WHERE timestamp >= '2026-09-07 00:00:00' AND timestamp < '2026-09-09 00:00:00';

OPTIMIZE TABLE fact_weather_sample FINAL;
