# 🛠 Ops Verification — VM 117 (2026-09-06)

Verified live against `uunw@172.30.191.48` (host `laundrytwin`). All commands
ran with evidence captured at the time of verification.

## Airflow (#32) — resolved

**Symptom (health endpoint, pre-fix):** `triggerer: unhealthy` and
`dag_processor: unhealthy` (last heartbeats 08:34 UTC, ~7h stale) while
`scheduler` and `metadatabase` were healthy.

**Root cause:** at 08:35 UTC the triggerer crashed with
`sqlite3.OperationalError: database is locked` while writing its job heartbeat
(`UPDATE job SET state=? ...`). Airflow runs on its default SQLite metadata DB
(standalone mode); concurrent writers hit SQLite's single-writer lock. The
scheduler survived, so `laundrytwin_warehouse_freshness` kept running green.

**Fix applied:**
- `docker restart analytics-airflow-1` → health restored:
  `metadatabase/scheduler/triggerer/dag_processor` all **healthy** (heartbeats
  fresh at 15:31 UTC).
- Deleted two **orphan DAGs** whose files no longer exist on disk (their job was
  superseded by the `laundrytwin-etl` container): `iris_machine_usage_to_clickhouse`
  (19 records) and `iris_machine_usage_backfill` (6 records) via
  `airflow dags delete`.

**Post-fix state:**
- DAGs remaining: only `laundrytwin_warehouse_freshness` (active, `is_paused=False`,
  schedule `*/5 * * * *`).
- Runs green through 15:35 UTC (success every 5 min since 2026-08-30).
- Airflow Variables were already set on the VM (the OpenTofu out-of-scope note is
  obsolete): `clickhouse_host=analytics-clickhouse-1`, `clickhouse_user`,
  `clickhouse_password`, `clickhouse_database`.

**Known limitation:** SQLite metadata DB can lock again under load. Recommend a
Postgres metadata DB for Airflow (and Superset metadata is already mitigated via
WAL + busy_timeout in `superset_config.py`).

## Superset dashboard (#33) — verified, one fix applied

**Datasets:** dashboard `LaundryTwin Analytics` (#2) has 7 charts over two
virtual datasets: `usage_enriched` (#7, joins `fact_machine_usage FINAL` +
`dim_machine` + `dim_branch`) and `temp_enriched` (#8).

**Metric → column mapping — verified correct (all 7):**

| Chart | Metric definition | Verdict |
| :---- | :---------------- | :------ |
| Revenue by Day | `SUM(amount_satang) / 100.0` | ✅ satang→baht at presentation (invariant respected) |
| Cycles by Day | `COUNT(*)` | ✅ 1 row = 1 usage/cycle |
| Utilization Heatmap | `SUM(duration_min)` | ✅ consistent with API heatmap ("duration minutes + cycles per machine-hour") |
| Revenue by Attribution | `SUM(amount_satang)/100.0` group by `attribution_state` | ✅ |
| Avg Cycle Duration | `AVG(duration_min)` | ✅ |
| Top 10 Machines | `cycle_count` + `total_revenue_baht` + `avg_duration_min` | ✅ |
| Temperature Curve | `AVG(temperature_c)` | ✅ column exists; join key handles UUID↔String machine_id |

- All referenced columns exist in the live ClickHouse schema
  (`apps/etl/src/schema.ts` mirrors `laundrytwin_analytics` on VM 117).
- No row inflation from the non-`FINAL` dim joins: fact 4,321 rows vs joined
  4,321 rows; revenue with FINAL-dims join = revenue plain = ฿168,130.
- Live data confirmed: 23 machines (12 washer / 11 dryer), 4.3k usages,
  3.49M temperature samples (all from dryers, avg 69.1 °C).

**Fix applied — chart #7 "Temperature Curve (Dryer):"** the chart had NO
`machine_kind` filter despite its title. Added
`adhoc_filters: machine_kind == 'dryer'` to the slice params (metadata DB
backup: `superset.db.bak-20260906`). Dryer-filtered query returns 6 dryers
with 1.1M–1.3M samples each.

## Other findings

- **Public app runs in demo mode by design:** `LAUNDRYTWIN_DEMO_MODE=true` on
  `/opt/laundrytwin/.env`, no `IRIS_READ_BASE_URL` — the public surface at
  `laundrytwin.duckdns.org` never exposes upstream credentials (AGENTS.md
  boundary). Real data flows inside ZeroTier (Superset/Airflow/ClickHouse).
- **Superset metadata DB** is SQLite with WAL + `busy_timeout=10000` (the same
  "database is locked" class was already mitigated here via
  `superset_config.py`).

## Rollback notes

- Airflow: `docker restart analytics-airflow-1` is itself the rollback;
  orphan DAGs can be recreated from
  `docs/superpowers/specs/2026-08-08-airflow-dag-iris-usage.md`.
- Superset slice #7: restore `superset.db.bak-20260906` or drop the
  `adhoc_filters` entry from `slices.params` (id=7).

## Addendum 2026-09-06 (evening) — Airflow metadata DB → Postgres (#43)

- Added `postgres:16` service to `deploy/analytics/compose.yaml`
  (`AIRFLOW__DATABASE__SQL_ALCHEMY_CONN=postgresql+psycopg2://airflow:...@analytics-postgres-1:5432/airflow`,
  `psycopg2-binary` added to `AIRFLOW__CORE__PIP_PACKAGES`, host port
  127.0.0.1:5433). Recreated the airflow container; metadata auto-migrated
  (71 tables in `public`), all health components healthy.
- **Pitfall hit:** Airflow Variables live in the metadata DB — after switching
  to a fresh Postgres, `clickhouse_*` variables were gone and the freshness
  DAG failed auth (run `scheduled__18:25` failed; 18:30/18:35 succeeded after
  re-seeding). Always re-seed variables on a metadata-DB switch:
  `airflow variables set clickhouse_host/user/password/database`.
- The `AIRFLOW_DB_PASSWORD` var was added to `/opt/analytics/.env`
  (openssl rand -hex 16); the old `airflow-data` volume is kept unmounted for
  rollback (SQLite history remains there).
- Known limitation resolved: no more SQLite single-writer lock class for
  Airflow. (Superset metadata remains SQLite with WAL + busy_timeout — its own
  bootstrap path is `deploy/analytics/bootstrap-superset.sh`.)
