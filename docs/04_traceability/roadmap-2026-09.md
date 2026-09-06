# 🗺 Roadmap — Remaining Work Plan (2026-09-06)

State of the project: **MVP pillars implemented and deployed** (RBAC, digital
twin reporting, analytics, MCP assistant, LINE bot, alert engine). Board:
17 Done / 6 Todo. This document plans the remaining items in execution order.

---

## 3. IaC gaps (#42)

**Status:** Airflow variables part is DONE (verified live on VM 117 —
`clickhouse_host/user/password/database` set; freshness DAG green).

### 3a. TLS / reverse proxy (public fronting)

- **Current reality:** the home-lab Pi fronts `*.laundrytwin.duckdns.org`
  (Caddy/TLS). The repo's `deploy/nginx.conf` is the in-stack app nginx
  (no TLS by design).
- **Decision:** keep the Pi as the TLS edge (it already works, avoids a second
  Caddy — a rejected alternative from 2026-08-31, per hindsight bank).
- **Deliverable:** a runbook `docs/02_architecture/deploy-runbook.md` —
  DNS, Caddy config, cert renewal, mapping of the four public hosts
  (root web, `superset.`, `airflow.`, `mcp.`). No tofu change.

### 3b. Superset metadata provisioning

- **Current reality:** admin user, ClickHouse DB connection, virtual datasets
  (`usage_enriched`, `temp_enriched`), dashboard and charts live in the
  `superset-home` volume SQLite (`/app/superset_home/superset.db`); backed up
  manually (`superset.db.bak-20260906`).
- **Plan:** idempotent bootstrap script `deploy/analytics/bootstrap-superset.sh`:
  1. `superset fab create-admin` (only if admin missing)
  2. Ensure ClickHouse database record (via CLI/API)
  3. Import datasets + dashboard from a seed export (`superset export-dashboards`
     → committed under `deploy/analytics/seed/`)
  4. Verify: dashboard renders 7 charts (reuse the E2E chart-data probe)
- **Acceptance:** a fresh `superset-home` volume gets a working dashboard with
  one script run; rollback = restore volume backup.

---

## 4. Airflow metadata DB → Postgres (new issue)

**Problem:** Airflow runs on its default SQLite metadata DB; 2026-09-06 the
triggerer crashed with `sqlite3.OperationalError: database is locked`
(restart fixed it). SQLite single-writer will keep biting under concurrency.

**Plan (deploy/analytics/compose.yaml):**
1. Add `postgres` service (postgres:16, named volume, healthcheck,
   credentials from env).
2. Set `AIRFLOW__DATABASE__SQL_ALCHEMY_CONN` →
   `postgresql+psycopg://airflow:***@analytics-postgres-1/airflow`.
3. On the VM: `airflow db migrate` against the new Postgres (fresh metadata —
   DAG definitions come from files; run history is disposable).
4. Remove the old `airflow-data` volume reference (keep it unmounted for
   rollback) and restart.
5. **Verify:** health endpoint all healthy; `laundrytwin_warehouse_freshness`
   picks up and runs green; no `database is locked` in logs after 24h.

**Rollback:** re-mount `airflow-data`, revert env, restart.
**Priority:** P2 (ops hardening; single-writer is acceptable short-term).
Same class of fix already applied to Superset via WAL + busy_timeout in
`superset_config.py`.

---

## 5. Phase 2 items

### 5a. Weather demand analysis API — F-12 (#34)

1. **Source:** Open-Meteo (no API key) as default, key-gated adapter for
   WeatherAPI (config `WEATHER_API_KEY`, optional).
2. **Normalize:** add `lat`/`lon`/`timezone` per branch (extend `dim_branch`
   via ETL or a config table); timestamps Asia/Bangkok.
3. **Feature:** new allow-listed MCP tool `get_weather_usage_correlation`
   (period + branch params, RBAC-scoped like existing analytics tools) —
   returns correlation + explicitly states limits (R12: correlation, never
   causation/forecast claims).
4. **Docs:** data contract update; envelope caveats.
5. **Acceptance:** tool returns `{correlation, sample_size, period, caveats}`
   for authorized branches only.

### 5b. ML recommendation — Epic 4 (#35)

Three deliverables (research → plan → metrics):

1. **Algorithm comparison doc** (`docs/06_ml/algorithm-comparison.md`):
   ARIMA vs Prophet vs simple heuristics (percentile threshold) for
   "off-peak window" detection, evaluated on existing usage history in
   ClickHouse (4.3k rows today — note data-volume limitation).
2. **ML dev plan** with phases: offline eval on historical usage →
   rule-based baseline → model candidate → A/B.
3. **Metrics:** offline MAE + hit-rate@k for window ranking; business metric
   = utilization lift during promoted windows; documented as Phase 2.

### 5c. Cost Analysis — Epic 1 (#39)

1. Inventory current deployment (VM 117: PVE, AMD FX-8350, 4 compose stacks,
   ZeroTier; domains via duckdns — free).
2. Compare: self-hosted (electricity + hardware amortization) vs cloud
   equivalent (ClickHouse Cloud, Airflow managed, 1 small VM).
3. Deliverable `docs/01_requirements/cost-analysis.md`:
   monthly estimate + explicit assumptions (no PII, no vendor quotes without
   verification).

### 5d. MQTT telemetry ingestion — F-04/F-05 (#41)

**Explicitly future scope** (AGENTS.md: telemetry ingestion not in current
implementation; no hardware changes without approved scope).

1. Design doc extending `docs/03_data_contracts/modbus_frame_analysis.md`:
   MQTT topics, payload envelope, `event_timestamp` vs `received_at`,
   register map versioning, dedup key + quarantine table (F-05 acceptance).
2. Broker config-gated (`MQTT_BROKER_URL`, never in browser).
3. Reuse existing ETL pattern (watermark, ReplacingMergeTree idempotency) —
   ingest path = MQTT → ClickHouse, keeping IRIS as read-only alternative.
4. Acceptance: invalid payloads quarantined with reason; unknown
   registers/states preserved (no fabrication).

---

## Execution order

1. **#40 presentation** (done 2026-09-06, commit `92b2093`)
2. **#42 3a runbook** (small, unblocks docs completeness)
3. **#42 3b Superset bootstrap script**
4. **Airflow Postgres** (reliability, before MQTT/ML which will load more)
5. **#39 Cost analysis** (quick, doc-only)
6. **#34 Weather** → **#35 ML research** → **#41 MQTT** (largest, last)
