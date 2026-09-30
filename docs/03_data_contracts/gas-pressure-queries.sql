-- ClickHouse queries — gas pressure (`otterimju2`)
--
-- Written and run against the real production server on 2026-09-30. Every
-- query below was executed as-is and returned data; none is written from memory.
-- One bug was caught this way and is recorded at the bottom — read that before
-- copying any pattern out of here.
--
-- Scope and safety boundary, from docs/03_data_contracts/ha_gas_sensor_contract.md:
-- these are descriptive queries over a pressure sensor. They do NOT detect a
-- gas leak and must never be presented as a safety system. Pressure may only
-- support a low-gas estimate when read together with machine state and
-- temperature. Dedicated life-safety detection and local alarms are outside the
-- current software-only scope.
--
-- This table has NO machine_id, machine_session_id or usage linkage — it stands
-- alone and cannot be joined to fact_machine_usage on a machine key. Verified by
-- querying system.columns for %machine%/%session%/%usage%: zero rows.
--
-- Usage:  clickhouse-client --query "<paste one block below>"
--         (on the VM: sudo docker exec analytics-clickhouse-1 clickhouse-client -q "...")

------------------------------------------------------------------------------
-- Q1. Current value per channel — the everyday "what is it right now" view.
--     Exactly one row per channel, via argMax.
------------------------------------------------------------------------------
SELECT
    channel,
    round(argMax(value_psi, recorded_at), 1) AS psi_now,
    max(recorded_at)                       AS measured_at,
    now() - max(recorded_at)               AS age_seconds
FROM laundrytwin_analytics.fact_gas_pressure_sample AS s FINAL
WHERE branch_slug = 'otterimju2'
GROUP BY channel
ORDER BY channel;

------------------------------------------------------------------------------
-- Q2. Hourly average per channel over a rolling window.
--     Change the INTERVAL to widen the window.
------------------------------------------------------------------------------
SELECT
    toStartOfHour(recorded_at) AS hour,
    channel,
    round(avg(value_psi), 1)   AS avg_psi,
    round(min(value_psi), 1)   AS min_psi,
    round(max(value_psi), 1)   AS max_psi,
    count()                    AS samples
FROM laundrytwin_analytics.fact_gas_pressure_sample AS s FINAL
WHERE branch_slug = 'otterimju2'
  AND recorded_at >= now() - INTERVAL 6 HOUR
GROUP BY hour, channel
ORDER BY hour DESC, channel;

------------------------------------------------------------------------------
-- Q3. Daily summary — this is the view that builds real history. Once the
--     table has more days, this becomes the input to any trend analysis.
--     unavailable is counted separately so a gap is never averaged away.
------------------------------------------------------------------------------
SELECT
    toDate(recorded_at)        AS day,
    channel,
    round(avg(value_psi), 1)   AS avg_psi,
    round(min(value_psi), 1)   AS min_psi,
    round(max(value_psi), 1)   AS max_psi,
    count()                    AS samples,
    countIf(value_psi IS NULL) AS unavailable
FROM laundrytwin_analytics.fact_gas_pressure_sample AS s FINAL
WHERE branch_slug = 'otterimju2'
GROUP BY day, channel
ORDER BY day DESC, channel;

------------------------------------------------------------------------------
-- Q4. Collector health — is it still reporting, and is the data usable?
--     Check this before trusting any other query. A channel whose
--     age_gap is large or whose last_seen is stale is not evidence of a
--     stable pressure; it is evidence of no data.
------------------------------------------------------------------------------
SELECT
    channel,
    count()                        AS samples,
    countIf(value_psi IS NULL)     AS unavailable,
    round(100.0 * countIf(value_psi IS NULL) / count(), 2) AS unavailable_pct,
    min(recorded_at)               AS first_seen,
    max(recorded_at)               AS last_seen,
    now() - max(recorded_at)       AS age_gap,
    uniqExact(toDate(recorded_at)) AS days_covered
FROM laundrytwin_analytics.fact_gas_pressure_sample AS s FINAL
WHERE branch_slug = 'otterimju2'
GROUP BY channel
ORDER BY channel;

------------------------------------------------------------------------------
-- Q5. Largest step changes — surfaces movement WITHOUT declaring a verdict.
--     Read this as "where did the number move", never as "a leak happened".
--     Note the gap_seconds column: a large delta across a long gap is a
--     resumption artefact, not a fast event.
------------------------------------------------------------------------------
SELECT
    channel,
    recorded_at,
    value_psi,
    recorded_at - prev_at AS gap_seconds,
    value_psi - prev_psi  AS delta_psi
FROM (
    SELECT
        channel, recorded_at, value_psi,
        any(recorded_at) OVER (PARTITION BY channel ORDER BY recorded_at
                               ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING) AS prev_at,
        any(value_psi)  OVER (PARTITION BY channel ORDER BY recorded_at
                               ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING) AS prev_psi
    FROM laundrytwin_analytics.fact_gas_pressure_sample AS s FINAL
    WHERE branch_slug = 'otterimju2'
      AND value_psi IS NOT NULL
)
WHERE prev_psi IS NOT NULL
ORDER BY abs(delta_psi) DESC
LIMIT 5;

------------------------------------------------------------------------------
-- Schema facts these queries rely on (DESCRIBE-verified 2026-09-30)
------------------------------------------------------------------------------
--   tenant_id        UUID
--   branch_id        UUID
--   branch_slug      String            <- 'otterimju2'
--   channel          Enum8('gas_run_a_pressure'      = 1,
--                          'gas_run_b_pressure'      = 2,
--                          'changeover_filter_pressure' = 3)
--   entity_id        String
--   unit             LowCardinality(String)         <- 'psi'
--   value_psi        Nullable(Float32)   <- NULL means unavailable, NEVER 0
--   state_raw        String             <- numeric string, the rounded psi.
--                                          It is not a machine state despite
--                                          the name. Do not filter on it.
--   is_available     UInt8
--   recorded_at      DateTime64(3)      <- event time, use this
--   ingested_at      DateTime64(3)      <- receive time
--
--   Engine: ReplacingMergeTree
--   ORDER BY (tenant_id, branch_id, channel, recorded_at)
--   PARTITION BY toYYYYMM(recorded_at)

------------------------------------------------------------------------------
-- Two rules that are easy to get wrong
------------------------------------------------------------------------------
--
-- 1. `FINAL` goes AFTER the alias: `FROM <table> AS s FINAL`.
--    Writing `FROM <table> FINAL AS s` is a syntax error
--    ("Expected alias cannot be here. (SYNTAX_ERROR)"). This exact mistake was
--    made and shipped in an earlier change today; the unit tests passed because
--    they regex-matched the token instead of running the SQL. The engine must
--    be ReplacingMergeTree for FINAL to be legal at all — against a plain
--    MergeTree it fails with `Code: 181 ILLEGAL_FINAL`.
--
--    FINAL is what makes re-reads safe. The collector re-reads an overlapping
--    ~3 hour window each cycle, so without FINAL an overlapping window would
--    double-count. With it, rows == distinct keys (verified: 895 == 895).
--
-- 2. Do NOT use `LIMIT 1 BY channel` for "the latest value per channel".
--    That returns N rows per channel (LIMIT N BY), not the newest one. It
--    produced 9 rows for 3 channels in testing. Use argMax (Q1), which picks
--    the value from the row with the max recorded_at.
--
-- Measured on this data at the time of writing (895 rows, 3 entities, 1 day
-- of history — the collector was deployed earlier the same day):
--   gas_run_a_pressure          98 samples,  17-21 psi
--   gas_run_b_pressure         347 samples,  87-111 psi
--   changeover_filter_pressure 450 samples,  15-21 psi
--   0 unavailable, 0 coerced zeros, 0 duplicate sort keys
-- gas_run_b sat 87-111 while the other two sat 15-21. Three hours of one
-- sensor is not a finding. Do not carry a number forward without a date.
