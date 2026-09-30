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
  VM 117; point another proxy at the local ports), ClickHouse data contents, the
  Superset and Airflow Postgres metadata, and container images (build on the Mac
  and push to the internal registry, or build locally per-app).

### What you have to do by hand on a new host

Nothing below is created by tofu or by any file in this repository. Each item is
a prerequisite for `docker compose up -d` succeeding.

1. **Create the ClickHouse warehouse volume.** `deploy/analytics/compose.yaml`
   declares it `external: true` so compose adopts the hand-made volume instead of
   creating an empty warehouse that reads as total data loss:
   `docker volume create analytics_clickhouse-data-restored`.
2. **Create the `superset` database and the `superset_app` role** in the Postgres
   container, and give that role enough rights on that database to run
   `superset db upgrade` (it owns the database or holds CREATE/ALTER on its
   schema). The `postgres` service in compose only initialises
   `airflow`/`airflow`; there is no script in this repository for either object.
3. **Run `deploy/analytics/bootstrap-superset.sh`** once Superset is up, to create
   the admin user, the ClickHouse database connection and the seed datasets and
   dashboards.
4. **Re-add the `clickhouse_*` Airflow variables** and unpause the
   `laundrytwin_warehouse_freshness` DAG (`deploy/analytics/dags`). A new host
   has an empty Airflow metadata DB.

### The analytics sync, and the gate in front of it

`null_resource.analytics_stack` syncs `deploy/analytics/` over `/opt/analytics`
with `rsync --delete`, through `scripts/analytics-rsync.sh`. That script prints
the full itemised dry-run diff and refuses to sync unless every path the sync
would delete is listed, one per line with a reason, in
`analytics-delete-allowlist.txt`. A refusal exits non-zero, which aborts the
apply before the .env is installed and before `docker compose up -d`.

Paths that must survive every sync instead belong in
`analytics-rsync.excludes`: `.env`, `*.before-*`, `*.bak-*` and `dags-disabled`.
`*.bak-*` is there because the inline `--exclude "*.before-*"` this replaced
does **not** match `compose.yaml.bak-*`: an rsync pattern with no `/` matches
trailing path components only and `*` does not cross `/`, so every `.bak-` copy
the operator keeps there is listed for deletion. Proven locally with
`rsync -ani --delete` against a destination tree holding both names; the count
of such files on the host was not re-verified here.

`analytics-delete-allowlist.txt` is deliberately empty: nothing in
`/opt/analytics` was enumerated when it was written (only the `.env` key names
were checked), so the first real apply is expected to stop at the gate and print
the paths it wanted to delete. That pause is the gate working.

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

Two variables must be the value **already in use**, not a freshly generated one,
because this apply delivers them but does not rotate the credential they belong
to:

- `clickhouse_reader_password` — the plaintext behind the Pi Caddyfile
  `basic_auth` for `clickhouse.laundrytwin.duckdns.org`. A wrong value passes
  `tofu validate` and breaks only that public route (401) while the API keeps
  working.
- `superset_db_password` — the password of the existing `superset_app` Postgres
  role, which nothing in this repository creates.

`/opt/analytics/.env` is rendered with `install -m 0600` over the live file, so
a key missing from `locals.tf` is a key deleted by the apply. `locals.tf` and
`apps/api/src/deploy-config.test.ts` both guard the interpolation set.

## Sequencing: a local working tree is not what gets deployed

`null_resource.app_checkout` runs `git fetch` + `checkout` + `reset --hard
origin/<app_repo_ref>`, and the analytics sync copies
`<app_install_dir>/deploy/analytics/` — the **checked-out** tree, not your local
one. Uncommitted or unpushed changes are therefore inert: nothing in this
directory reaches the host until it is merged **and** pushed, and the apply is
run with `app_repo_ref` set to the approved immutable commit. Re-run the sync
gate's dry-run diff against post-merge `origin/main`, not against a local tree.

## Rollback

Stacks keep the previous images until pruned: `cd /opt/<dir> && docker
compose down`, `git checkout <previous-ref>`, `docker compose up -d`.

ClickHouse data lives in **named docker volumes**, plural, and there are two of
them on VM 117:

- `analytics_clickhouse-data-restored` — the live warehouse, mounted by
  `deploy/analytics/compose.yaml` and declared `external: true`.
- `analytics_clickhouse-data` — no longer mounted by anything. A data-recovery
  merge on 2026-09-30 inserted the 2026-08-31 → 2026-09-16 window that existed
  only there into the live volume, but the merge inserted a de-duplicated set,
  this volume still holds pre-existing duplicate rows that were deliberately not
  merged, and nothing has verified the two are equivalent. **Do not remove or
  prune it without an explicit, recorded decision.**

Back up both volumes before any version change, and treat a
`docker volume rm analytics_clickhouse-data` in any document you read as a
write to the second one.
