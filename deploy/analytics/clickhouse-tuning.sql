-- ClickHouse tuning applied live on VM 117 (laundrytwin_analytics), 2026-08-30.
-- Re-apply on a fresh warehouse after the ETL creates the tables.
--
-- Why: fact_machine_usage is ReplacingMergeTree ORDER BY (tenant_id, branch_id, usage_id)
-- so time-range chart queries (Superset: last 7/30 days by started_at) could not prune
-- parts and scanned the whole table (3.2s on the first dashboard hit). The projection
-- re-orders a copy by (branch_id, started_at, usage_id); ClickHouse auto-selects it for
-- time-range reads while the base key keeps ReplacingMergeTree dedup semantics intact.
-- A full table rewrite (changing the base ORDER BY) would change dedup granularity and
-- risk orphaned versions when a usage's started_at changes, so the projection is safer.

ALTER TABLE laundrytwin_analytics.fact_machine_usage
  MODIFY SETTING deduplicate_merge_projection_mode = 'rebuild';

ALTER TABLE laundrytwin_analytics.fact_machine_usage
  ADD PROJECTION IF NOT EXISTS proj_by_time
  (SELECT * ORDER BY (branch_id, started_at, usage_id));

ALTER TABLE laundrytwin_analytics.fact_machine_usage
  MATERIALIZE PROJECTION proj_by_time SETTINGS mutations_sync = 2;
