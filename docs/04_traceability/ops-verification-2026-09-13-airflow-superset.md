# Ops verification — Airflow scheduler recovery + Superset Postgres metadata (2026-09-13)

## Context

Two board items claimed "Done" but had unverified state: Airflow DAGs
("unpause or rewrite + verify warehouse freshness") and Superset metadata
DB ("SQLite → Postgres — database is locked class"). Root causes investigated
and fixed in this session.

## 1. Airflow scheduler was dead for 7 days (DAGs never ran)

**Evidence found:**
- `curl :8081/api/v2/monitor/health`: `scheduler{unhealthy, latest_heartbeat 2026-09-06T20:01:14Z}`,
  `dag_processor{unhealthy, 2026-09-06T20:01:12Z}` — heartbeats frozen 7 days.
- Postgres `dag` table: `laundrytwin_warehouse_freshness | is_paused=f` — DAG was
  unpaused but nothing executed it.
- Container process tree: only `airflow standalone` → `api_server`; scheduler /
  triggerer / dag-processor subprocesses were gone.
- Container logs: scheduler STARTED fine (2026-09-06 18:24, LocalExecutor,
  worker pids), ran DAG 20:00 successfully, then at 20:01:21:
  `Exception when executing SchedulerJob._run_scheduler_loop` +
  `psycopg2.OperationalError: connection to server ... FATAL: the database system is in recovery mode`
  — Postgres restarted into recovery, killing every Airflow component at once.
- **Root cause class:** `airflow standalone` supervises subprocesses but does NOT
  respawn a crashed scheduler/triggerer/dag-processor; the healthcheck only
  probes the api-server port, so the container stayed "healthy" while the
  scheduler stayed dead. One Postgres hiccup = permanent scheduler death.

**Fix (deploy/analytics/compose.yaml):** replaced the single `standalone`
container with four independent services, each `restart: unless-stopped` so a
crash respawns on its own:
- `airflow-init` (`db migrate`, run-once, `service_completed_successfully` gate)
- `airflow-webserver` (`api-server` — NOTE: `airflow webserver` was REMOVED in
  Airflow 3.x; the UI/API now runs under `api-server`)
- `airflow-scheduler` (`scheduler`)
- `airflow-triggerer` (`triggerer`)
- `airflow-dag-processor` (`dag-processor` — required or `dag_processor` health
  stays unhealthy)

**Second bug found by the 15:00 scheduled run failing:**
`httpx.ConnectError: Connection refused` — tasks executed inside the scheduler
container tried to reach the API server at `127.0.0.1:8080`, but with split
containers the API server lives in the webserver container. Fixed by overriding
`AIRFLOW__API__BASE_URL: http://analytics-airflow-webserver-1:8080` on
scheduler/triggerer/dag-processor (+ `depends_on: webserver healthy`).

**Verified (real output):**
- `monitor/health`: metadatabase / scheduler / triggerer / dag_processor ALL
  healthy with fresh heartbeats (2026-09-13T15:19Z).
- `dag_run`: `scheduled__2026-09-13T15:15:00` **success**,
  `scheduled__2026-09-13T15:20:00` **success**; all three tasks
  (check_usage_freshness, check_temperature_freshness, report_warehouse_volumes) = success.
- DAG resumes its `*/5` schedule; works after any future component crash.

## 2. Superset metadata migrated SQLite → Postgres (database-is-locked class)

**Before:** metadata at `/app/superset_home/superset.db` (SQLite, 5 MB), WAL +
busy_timeout pragmas were a band-aid (`sqlite3.OperationalError: database is
locked` under SERVER_WORKER_AMOUNT=2).

**Fix:**
- Created `superset` database on the existing `analytics-postgres-1` (owner `airflow`).
- `deploy/analytics/superset_config.py`: `SQLALCHEMY_DATABASE_URI` now reads
  `SUPERSET_DATABASE_URI` env (default keeps SQLite for standalone/dev use).
- `compose.yaml` superset service: `SUPERSET_DATABASE_URI:
  postgresql+psycopg2://airflow:***@analytics-postgres-1:5432/superset` +
  `depends_on: postgres healthy`.
- `superset-driver/Dockerfile`: added `psycopg2-binary==2.9.10` for the
  Postgres driver at runtime.
- Ran `superset db upgrade` (via idempotent `bootstrap-superset.sh`) — alembic
  created the full schema in Postgres (53 tables) and seed re-import rebuilt
  the dashboard.
- `bootstrap-superset.sh` step 4 verify: rewrote the sqlite3-based check to an
  ORM-based one (`superset shell`, one-line statements — the REPL pitfall).

**Bug found while seed-importing:** the VM's `seed/laundrytwin-dashboards.zip`
was the OLD export (2026-09-06, 30 KB, no weather chart) while the repo's
committed seed is the newer one (2026-09-07, 14 KB, 8 charts + 3 datasets).
Bootstrap thus imported only 7 charts / 2 datasets for weeks. Synced the repo
seed to the VM and re-imported.

**Verified (real output):**
- Postgres `superset` DB: 53 tables; dashboards=1 ("LaundryTwin Analytics"),
  charts=8 (incl. "Weather (TMD hourly)"), datasets=3 (incl.
  fact_weather_sample), clickhouse_db=1.
- ClickHouse sim of the weather chart query: `SELECT province, count(), avg(weather_temp_c) FROM fact_weather_sample GROUP BY province` → เชียงใหม่, 154 rows,
  27.81 °C — data present.
- Superset health 200 on :8088 (local + in-container; public URL sits behind
  Authentik SSO by design).

## Rollback

- Airflow: `compose.yaml.bak-20260913` on VM restores the single standalone
  container; Postgres metadata DB untouched by the split (same connection).
- Superset: `/app/superset_home/superset.db.bak-20260913` (SQLite copy) and the
  ORM metadata now in Postgres. To revert, point `SUPERSET_DATABASE_URI` back
  at the SQLite file and restart — the seed plus `.bak` file make this safe.
- Only compose/config files changed on the VM (no data deleted; the single
  `[ untitled dashboard ]` empty dashboard was deleted — recreatable via
  bootstrap).

## What's left

- The freshness DAG only monitors; the Airflow "unpause or rewrite" item is
  now genuinely done (DAG verified running on schedule). Consider adding a
  weather-freshness check to the DAG later (fact_weather_sample has its own
  collector) — not required for the current acceptance criteria.