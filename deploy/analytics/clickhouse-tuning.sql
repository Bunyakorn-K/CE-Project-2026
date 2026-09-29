-- ClickHouse tuning applied live on VM 117 (laundrytwin_analytics), 2026-08-30.
-- Re-apply on a fresh warehouse after the ETL creates the tables.
--
-- NOTE: because this projection is `SELECT *`, it holds its own COPY of
-- fact_machine_usage.status. Any migration that renumbers or retypes that
-- column must DROP this projection first and re-apply it afterwards; while it
-- is attached ClickHouse refuses the ALTER with `Code: 70 ... Cannot apply
-- ALTER because it breaks projection proj_by_time`. The status-enum
-- renumbering (apps/api/scripts/migrate-usage-status-enum.ts) does exactly
-- that on 2026-09-29 and rebuilds it in the same run, so re-applying this file
-- afterwards would only duplicate work.
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
