# Analytics Stack Deployment Mapping

## Current Deployment (VM 117: /opt/analytics)

## Verified operating boundaries (2026-08-14)

- `clickhouse.laundrytwin.duckdns.org` is an Authentik-protected Caddy route to
  the ClickHouse HTTP interface on the analytics VM. It is not an
  unauthenticated public database endpoint. Do not bypass Authentik, expose a
  second ClickHouse port, or bind the HTTP port to localhost while Caddy is on
  the Pi; that breaks the upstream route with HTTP 502.
- Caddy removes the non-ClickHouse `fbclid` query parameter before proxying.
  Do not configure arbitrary URL parameters as ClickHouse settings.
- `fact_machine_usage` contains one synthetic smoke-test row only. It is not
  IRIS production data, pipeline-freshness evidence, or representative
  dashboard validation data. Machine-event and temperature-sample fact tables
  contain no rows.
- The deployed `iris_machine_usage_to_clickhouse` DAG is paused. Its activation
  gate is defined in
  `docs/superpowers/specs/2026-08-08-airflow-dag-iris-usage.md`.
- The live Superset dashboard and charts exist. Historical setup notes below
  that say datasets or charts still need to be added describe an earlier
  deployment phase, not the current state.

### Compose Project: `analytics`

### Services

| Service | Image | Ports (Host) | Data Volume |
|---------|-------|--------------|-------------|
| ClickHouse | `clickhouse/clickhouse-server:25.8` | 8123 (HTTP), 127.0.0.1:9009 (Native) | `clickhouse-data` |
| Airflow | `apache/airflow:3.3.0` (standalone) | 8081 | `airflow-data` |
| Superset | `apache/superset:6.1.0` | 8088 | `superset-home` |
| MCP Inspector | `node:22-bookworm-slim` + npx | 6274 | — |

### Credentials (`/opt/analytics/.env` mode 600)

- `CLICKHOUSE_PASSWORD`
- `AIRFLOW_ADMIN_PASSWORD` (also used for Superset admin)
- `SUPERSET_SECRET_KEY`

### Persistence Paths (Docker volumes)

- `clickhouse-data` → `/var/lib/clickhouse`
- `airflow-data` → `/opt/airflow`
- `superset-home` → `/app/superset_home`

### Health Checks

All services have HTTP health endpoints:
- ClickHouse: `http://127.0.0.1:8123/ping`
- Airflow: `http://127.0.0.1:8080/api/v2/monitor/health`
- Superset: `http://127.0.0.1:8088/health`

### Network

- All ports bound to `0.0.0.0` except ClickHouse native (127.0.0.1:9009)
- Pi Caddy reverse-proxies `*.laundrytwin.duckdns.org` → VM 10.10.0.117 ports

### Airflow DAGs Location

Current: No DAGs mounted. Airflow uses internal `/opt/airflow/dags` via volume.

Need to add:
```yaml
volumes:
  - ./dags:/opt/airflow/dags
```

### ClickHouse Initialization

- Default user: `admin` (password from `.env`)
- No schema yet — Airflow DAG will create tables on first run

### Superset State

- DB migrated + admin user created (same password as Airflow)
- No datasets/charts/dashboards yet
- Will connect to ClickHouse via native protocol (port 9009)

---

## Required Changes for Phase 1

### 1. Add Airflow DAGs directory mount

```yaml
# In compose.yaml airflow service
volumes:
  - airflow-data:/opt/airflow
  - ./dags:/opt/airflow/dags
```

Create `/opt/analytics/dags/` with initial DAG.

### 2. Update compose.yaml on VM

Deploy via:
```bash
cd /opt/analytics
# add dags mount
docker compose up -d
```

### 3. Superset ClickHouse Connection

After DAG creates tables:
- URL: `clickhouse://admin:${CLICKHOUSE_PASSWORD}@host.docker.internal:9009/default`
- Or use VM IP: `clickhouse://admin:xxx@10.10.0.117:9009/default`

### 4. Secret Management

Current `.env` is file-based. For production:
- Move to external secret manager or
- Keep file with strict perms (current approach works)

---

## Notes for Airflow DAG Development

- Airflow 3.3.0 standalone mode = scheduler + webserver + triggerer in one container
- DAGs reload automatically (watch `dag_dir_list_interval`)
- Use `PostgresHook` for ClickHouse native client or HTTP interface
- Authentication: ClickHouse `admin` user with password from `.env`