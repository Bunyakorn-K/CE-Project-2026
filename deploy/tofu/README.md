# deploy/tofu — provision LaundryTwin on any host with OpenTofu

Reproduces the VM 117 deployment on a fresh machine: clone the repo, render the
three .env files from tofu variables, rsync the analytics compose files, then
build and start both docker-compose stacks and smoke-test them.

## Layout this creates (identical to VM 117)

| Path | Contents |
|---|---|
| `/opt/laundrytwin` | app repo + compose (api, web, playground, etl) |
| `/opt/analytics` | analytics compose (clickhouse 26.3, superset 6.1, airflow 3.3.1, redis 8, mcp) |
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
service answers wrong (api 8787, web 8080, playground 8082, clickhouse 8123,
superset 8088, airflow 8081).

## What tofu manages vs what it does not

- **Managed**: repo checkout, the three .env files, analytics files rsync,
  both compose stacks (build/up/down), smoke checks.
- **NOT managed**: the reverse proxy + public TLS (the home-lab Pi Caddy fronts
  VM 117; point another proxy at the local ports), ClickHouse data contents
  (fresh volume on a new host), Superset dashboard/metadata (fresh SQLite on a
  new host — recreate the admin user, DB connection and virtual datasets), and
  Airflow variables (re-add clickhouse_host/user/password/database).

## Version pins baked into the repo files tofu deploys

- ClickHouse `26.3` LTS — **do not raise to 26.6+ on AVX2-less CPUs** (SIGILL,
  verified on VM 117 AMD FX-8350).
- Superset `6.1.0` + clickhouse-sqlalchemy 0.2.x / SQLAlchemy 1.4 driver image
  (dialect `clickhouse://`).
- Airflow `3.3.1`, Redis `8-alpine`, Node `24-bookworm-slim`, nginx `1.30-alpine`.

## Secrets

`terraform.tfvars` and `rendered/` are git-ignored. Pass secrets via tfvars or
`-var` / environment; never commit them.

## Rollback

Both stacks keep the previous images until pruned: `cd /opt/<dir> && docker
compose down`, `git checkout <previous-ref>`, `docker compose up -d`. ClickHouse
volume is a named docker volume — back it up before any version change.
