# 🗺 Roadmap — Remaining Work Plan (2026-09-06, status refreshed 2026-09-14)

State of the project: **MVP pillars implemented and deployed** (RBAC, digital
twin reporting, analytics, MCP assistant, LINE bot, alert engine, AI console).
This document plans the remaining items in execution order; completed items are
marked with their evidence.

---

## 3. IaC gaps (#42)

**Status:** DONE — Airflow variables part was completed (verified live on VM
117 — `clickhouse_host/user/password/database` set; freshness DAG green), and
the runbook deliverable shipped (see below).

### 3a. TLS / reverse proxy (public fronting) — DONE 2026-09-06

- **Current reality:** the home-lab Pi fronts `*.laundrytwin.duckdns.org`
  (Caddy/TLS). The repo's `deploy/nginx.conf` is the in-stack app nginx
  (no TLS by design).
- **Decision:** keep the Pi as the TLS edge (it already works, avoids a second
  Caddy — a rejected alternative from 2026-08-31, per hindsight bank).
- **Deliverable:** `docs/02_architecture/deploy-runbook.md` — DNS, Caddy
  config, cert renewal, mapping of the public hosts (root web, `superset.`,
  `airflow.`, `mcp.`, `chat.`, `registry.`). No tofu change.

### 3b. Superset metadata provisioning — DONE 2026-09-13

- Idempotent bootstrap script `deploy/analytics/bootstrap-superset.sh` ships:
  create admin (if missing), grant Admin can_write roles, upsert ClickHouse DB
  connection, import seed dashboards/datasets (UUID-based), ORM verify step.
- **Beyond plan:** metadata was migrated from SQLite to Postgres
  (`analytics-postgres-1`, db `superset`) — the `database is locked` class is
  gone. Evidence:
  `docs/04_traceability/ops-verification-2026-09-13-airflow-superset.md`.
- Acceptance met: a fresh volume gets a working dashboard with one script run;
  rollback = point `SUPERSET_DATABASE_URI` back at the SQLite backup.

---

## 4. Airflow metadata DB → Postgres — DONE 2026-09-13

**Problem:** Airflow ran on SQLite metadata; 2026-09-06 the triggerer crashed
with `sqlite3.OperationalError: database is locked`.

**What was done (deploy/analytics/compose.yaml):**
1. Postgres service added (postgres:16, named volume, healthcheck).
2. Airflow split into per-role services (init/webserver/scheduler/triggerer/
   dag-processor), each `restart: unless-stopped` — `airflow standalone` does
   NOT respawn a crashed scheduler (verified: scheduler was dead 7 days while
   the api-server healthcheck kept the container "healthy").
3. `AIRFLOW__DATABASE__SQL_ALCHEMY_CONN` → Postgres `airflow` DB; Superset
   metadata moved to the same Postgres (`superset` DB).
4. `AIRFLOW__API__BASE_URL` on non-webserver roles points at the webserver
   container (tasks execute in the scheduler container; 127.0.0.1 gave
   `httpx.ConnectError` on every run).
5. **Verify:** health endpoint all healthy with fresh heartbeats;
   `laundrytwin_warehouse_freshness` runs green every 5 min; no `database is
   locked` since.

Evidence: `docs/04_traceability/ops-verification-2026-09-13-airflow-superset.md`.
**Rollback:** `compose.yaml.bak-20260913` restores the standalone container.

---

## 5. Phase 2 items

### 5a. Weather demand analysis API — F-12 (#34) — DONE 2026-09-10

1. Source TMD (Thai Meteorological Dept) per-branch collector
   (`laundrytwin-weather-1`, loop every 5 min → `fact_weather_sample`),
   key in `/opt/laundrytwin-etl/.env` (never in repo).
2. `dim_branch_location` ops-provisioned table drives collection targets
   (never `dim_branch` — ETL overwrites it with NULLs).
3. Warehouse all-UTC; MCP tool `get_weather_usage_correlation` ships
   (RBAC-scoped, states limits — R12).
4. Correlation verified significant at n=77 (เชียงใหม่
   corr(temp,cycles)=+0.418, corr(rh)=−0.359, r_crit≈0.22 at p<0.05).
   Limitation: TMD hourly returns byte-identical per-province series — a
   location-specific source is needed before per-branch weather curves.

### 5b. ML recommendation — Epic 4 (#35) — baseline shipped 2026-09-14

MCP tool **`get_off_peak_windows`** (R09 baseline) implemented, tested and
deployed — sixth allow-listed analytics tool:

1. **Baseline = percentile heuristic** (per `docs/06_ml/algorithm-comparison.md`):
   bucket by (hour × weekday) in Asia/Bangkok local hours, drop buckets under
   `minCycles`, sort by paid-cycle usage ascending, return bottom
   `percentile`% with rank 1 = most off-peak. Output carries the rule used
   (R09 acceptance).
2. **Evidence:** `ops-verification-2026-09-14-r09-offpeak.md` — live call on
   Chiang Mai branch returns Mon 03:00 as #1 off-peak (business-sensible).
3. **Remaining phases** (research doc): Phase B evaluation harness, Phase C
   model candidate (≥ 3 months history), Phase D promotion A/B — all future.

### 5c. Cost Analysis — Epic 1 (#39) — DONE 2026-09-06

`docs/01_requirements/cost-analysis.md`: self-hosted ~555–715 ฿/mo vs managed
~$120–350/mo (~7–20×). Assumptions explicit; re-validate vendor quotes before
any migration decision.

### 5d. MQTT telemetry ingestion — F-04/F-05 (#41) — **DESCOPED 2026-09-07**

**Closed as not planned.** The live system does not use MQTT: telemetry flows
IRIS gateway → IRIS Postgres → our ETL → ClickHouse, and device ingestion is
IRIS's responsibility (see `docs/integration/iris-laundrytwin-read-api.md`).
A parallel MQTT path would be speculative scope with no verified register map.

If scope ever changes (direct device access after IRIS retires):

1. Design doc extending `docs/03_data_contracts/modbus_frame_analysis.md`:
   MQTT topics, payload envelope, `event_timestamp` vs `received_at`,
   register map versioning, dedup key + quarantine table (F-05 acceptance).
2. Broker config-gated (`MQTT_BROKER_URL`, never in browser).
3. Reuse existing ETL pattern (watermark, ReplacingMergeTree idempotency) —
   ingest path = MQTT → ClickHouse, keeping IRIS as read-only alternative.
4. Acceptance: invalid payloads quarantined with reason; unknown
   registers/states preserved (no fabrication).

---

## 6. Added since original plan (2026-09)

- **AI console (Bifrost gateway) + demo login** — DB-driven `ai_settings`
  (AES-256-GCM key with `sha256(BETTER_AUTH_SECRET)`), Vercel AI SDK
  streaming gateway, MCP tools as SDK `dynamicTool`s. Demo login via
  `POST /api/demo/session` (no password accounts in demo).
- **LibreChat MCP/agent tool testing** — free OpenRouter model
  (`inclusionai/ling-3.0-flash-fin:free`) + Agents endpoint + agent with the
  then-current 5 analytics MCP tools, E2E-verified (tool call → result → answer).
  The current registry has 6 tools after the off-peak addition; current signed
  scope and all six tools have local code/test evidence, not fresh browser E2E.
  Evidence: `ops-verification-2026-09-14-librechat-tools.md`.
- **Internal docker registry** (`registry.laundrytwin.duckdns.org`) — per-app
  images via turbo prune + minimal runtime (~29–69 MB), VM pulls via
  `127.0.0.1:5000` (no NAT loopback on public IP).

## Execution order (as of 2026-09-14)

1. ~~#40 presentation~~ — done 2026-09-06, commit `92b2093`
2. ~~#42 3a runbook~~ — done 2026-09-06
3. ~~#42 3b Superset bootstrap~~ — done 2026-09-13
4. ~~Airflow Postgres~~ — done 2026-09-13
5. ~~#39 Cost analysis~~ — done 2026-09-06
6. ~~#34 Weather~~ — done 2026-09-10
7. **#35 ML research** — next open item (offline eval on historical usage)
