# deploy/tofu — provision LaundryTwin on any host with OpenTofu

Reproduces the VM 117 deployment on a fresh machine: clone the repo, render the
.env files from tofu variables, rsync the analytics compose files, then build
and start the compose stacks and smoke-test them.

## Layout this creates (identical to VM 117)

| Path | Contents |
|---|---|
| `/opt/laundrytwin` | app repo + compose (api, web, etl, weather) |
| `/opt/analytics` | analytics compose (clickhouse 26.3, superset 6.1, airflow 3.3.1 per-role, postgres 16, redis 8, mcp) |
| `/opt/librechat` | LibreChat compose (app, mongodb, meilisearch) |
| `/srv/registry` | internal docker registry v2 (htpasswd, config.yml) |
| `/opt/laundrytwin-etl` | ETL .env + watermark data |

## Usage (run ON the target host)

```bash
cd deploy/tofu
cp terraform.tfvars.example terraform.tfvars   # fill in real secrets
tofu init
tofu plan                                      # review
tofu apply                                      # checkout + envs + build + up + smoke
```

The final `null_resource.smoke` curls the local ports and fails the apply if any
service answers wrong (api 8787 incl. /mcp, web 8080 incl. /playground,
clickhouse 8123, superset 8088, airflow 8081, postgres 5433, registry 5000,
LibreChat 3080).

## What tofu manages vs what it does not

- **Managed**: repo checkout, the .env files, analytics/librechat/registry
  files rsync, compose stacks (build/up/down), smoke checks.
- **NOT managed**: the reverse proxy + public TLS (the home-lab Pi Caddy fronts
  VM 117; point another proxy at the local ports), ClickHouse data contents
  (fresh volume on a new host), Superset metadata (fresh Postgres `superset`
  DB on a new host — run `bootstrap-superset.sh` to recreate admin, DB
  connection and virtual datasets from the committed seed), Airflow metadata
  (fresh Postgres `airflow` DB — re-add `clickhouse_*` variables and unpause
  the freshness DAG), and container images (build on the Mac and push to the
  internal registry, or build locally per-app).

## Version pins baked into the repo files tofu deploys

- ClickHouse `26.3` LTS — **do not raise to 26.6+ on AVX2-less CPUs** (SIGILL,
  verified on VM 117 AMD FX-8350).
- Superset `6.1.0` + clickhouse-sqlalchemy 0.2.x / SQLAlchemy 1.4 driver image
  (dialect `clickhouse://`; metadata URI points at analytics-postgres-1).
- Airflow `3.3.1` split into per-role services (init/webserver/scheduler/
  triggerer/dag-processor) on Postgres metadata — see
  `docs/04_traceability/ops-verification-2026-09-13-airflow-superset.md`.
- Redis `8-alpine`, Postgres `16`, Node `24-bookworm-slim`, nginx `1.30-alpine`.

## Secrets

`terraform.tfvars` and `rendered/` are git-ignored. Pass secrets via tfvars or
`-var` / environment; never commit them.

## Rollback

Stacks keep the previous images until pruned: `cd /opt/<dir> && docker
compose down`, `git checkout <previous-ref>`, `docker compose up -d`. ClickHouse
volume is a named docker volume — back it up before any version change.