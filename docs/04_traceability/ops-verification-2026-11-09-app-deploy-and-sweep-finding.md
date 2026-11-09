# The sweep is scheduled and firing in production — and every run fails on a missing reporting source

**Date:** 2026-11-09
**Commit deployed:** `f54f4cf` (image built by CI, pulled from GHCR)
**Image:** `ghcr.io/bunyakorn-k/ce-project-2026-app@sha256:5157e5329fb0c219887199f9f6ec43c233271f98974559123fda5985a0e928f1`,
tagged locally as `laundrytwin:deploy-f54f4cf-20261109`
**Status: deployed and reachable. R05 and R06 are NOT closed — the alert engine
cannot run in production because IRIS reporting has never been configured.**

## Why this deploy happened

`docs/superpowers/plans/2026-11-09-requirement-closure-batch.md` closes R05 on a
production DAG run and R06 on a production sweep summary that names its window.
Both needed an image that contains `POST /api/internal/alerts/sweep`, and
production ran `deploy-4fb470d-20261109`, which does not.

## Gate items, in order

1. **Rollback image:** `laundrytwin:deploy-4fb470d-20261109`, still on the host
   (`docker images` 2026-11-09 09:46 UTC). Also `laundrytwin:deploy-ffa4e15-20261002`.
2. **SQLite backup through the API, not a copy:**
   ```text
   /data/backup-predeploy-2026-11-09T093502370Z.sqlite
   bytes: 229,376   source main file: 4,096   integrity: ok
   tables: 15   users: 5   access_grant: 4
   ```
   The source's 4 KB main file against a 224 KB backup is the WAL trap in
   numbers: a `cp` of `laundrytwin.sqlite` would have produced the 4 KB file and
   looked like a backup. Run inside the running container with
   `docker exec -e NODE_PATH=/app/node_modules laundrytwin-app-1 node /data/sqlite-backup.cjs`
   (`better-sqlite3` is at `/app/node_modules`, which is why `NODE_PATH` is
   needed for a script living in `/data`).
3. **Warehouse backup:** scheduled and restore-verified earlier the same day —
   `docs/04_traceability/ops-verification-2026-11-09-warehouse-backup-scheduled.md`.
4. **Explicit request:** the owner asked for the deploy in chat.

## The deploy, honestly

The image was tagged locally and started with
`APP_IMAGE=laundrytwin:deploy-f54f4cf-20261109 docker compose up -d app`.

**It did not go smoothly, and the app was down for about six and a half minutes.**
Sequence, from the daemon log and `docker inspect`:

```text
09:45:17  docker stop laundrytwin-app-1  → SIGTERM
09:45:17  "Container failed to exit within 10s of signal 15 - using the force"
09:45:18  stream copy error: reading from a closed fifo  (twice)
09:45:18  exit 137
09:45:28  "Container failed to exit within 10s of kill - trying direct SIGKILL"
          → the stop call hung; port 8787 unbinding, health 000
09:46-49  compose up -d failed: name "/45ac36f71054_laundrytwin-app-1" in use
09:49:39  docker rm -f finally cleared it ("removal ... already in progress"),
          compose created and started the new container under the rename artifact
09:51:49  container up, health 200
```

Two separate problems, both recorded rather than glossed:

- **The host was at load average 10–37** while this ran, which is why a 10-second
  SIGTERM grace turned into a multi-minute kill and why every docker call
  returned slowly. The load was not caused by the deploy (`ps --sort=-pcpu`
  showed ClickHouse at 13%, a gunicorn at 4%, and the rest was `ps` itself), but
  the deploy ran into it.
- **Compose's recreate renames the old container to `<id>_<name>` and that name
  was already stuck** from the first, killed attempt. `docker ps -a` did not list
  the holder; the daemon reported the name in use for a container id that
  `docker inspect` answered "No such object" for. Removing the running container
  outright and letting compose create a fresh one is what worked.

**Consequence still on the host:** the running container is now named
`45ac36f71054_laundrytwin-app-1`, not `laundrytwin-app-1`, because compose
created it under the rename artifact. It is the project's container by label and
compose manages it, but any script that addresses it by name needs updating.
Clearing it needs a maintenance-window recreate.

**Second self-inflicted interruption:** a `docker compose up -d airflow-scheduler`
was killed mid-recreate, which left the analytics stack with
`analytics-airflow-webserver-1` and `analytics-airflow-scheduler-1` in `Created`
(not running) and the init container recreated. Restored with
`docker compose up -d airflow-init airflow-webserver airflow-scheduler`
(webserver healthy at ~10:04 UTC, scheduler up at ~10:05). The triggerer and
dag-processor were never touched.

I interrupted the image pull on the *first* attempt by timing out the foreground
call; the pull itself completed and the second call answered "Image is up to
date", so the outage is not a pull problem.

## Post-change smoke, over public TLS from the Mac

```text
/health 200   / 200   /login 200   /privacy 200
/api/me 401   /mcp 401   /api/openapi.json 200
/assets/nope.js 404   POST /nope 404
bundle  index-dD3HfW6M.js → index-1e9yA06P.js   (386,590 → 391,232 bytes)
LIFF id present in the served bundle: 2011592166-uToRdTwS
/health body  {"ok":true,"reportingConfigured":false,"demoMode":false}
```

The bundle hash change is what proves the new image is actually serving; the
LIFF id being in it proves the build kept the LINE branches rather than
optimising them out. Same checks from inside the host against
`http://127.0.0.1:8787` returned the same statuses, so nothing is TLS-specific.

Sweep route behaviour on the new image, measured on the host:

```text
POST /api/internal/alerts/sweep                 (no token)   401
GET  /api/internal/alerts/sweep                 (method)     404
POST /api/internal/alerts/sweep   (wrong token)              401
```

## The DAG is scheduled, fires on time, and fails: 503 REPORTING_SOURCE_UNAVAILABLE

Installed `laundrytwin_alert_sweep.py` in `/opt/analytics/dags/`, set the
Airflow Variable `alert_sweep_token` from `/opt/laundrytwin/.env` via
`airflow variables import` (never on argv, never printed), and gave the
scheduler the network it needs:

```text
analytics-airflow-scheduler-1 networks: analytics_default laundrytwin_default
getent hosts app → 172.18.0.2
http://app:8787/health from the scheduler → 200
```

Run history (metadata DB):

| run | type | started | state |
|---|---|---|---|
| `manual__2026-11-09T10:06:39.029927+00:00` | manual | queued, never ran (DAG was paused — newly added DAGs default to paused here) | failed |
| `scheduled__2026-11-09T10:20:00+00:00` | scheduled | 10:20:00 exactly | **failed** |
| `scheduled__2026-11-09T10:25:00+00:00` | scheduled | 10:25:00 exactly | **failed** |

The failure, verbatim from the task log:

```text
AirflowFailException: alert sweep answered HTTP 503 at
http://app:8787/api/internal/alerts/sweep:
{"error":{"code":"REPORTING_SOURCE_UNAVAILABLE",
          "message":"IRIS reporting is not configured for LaundryTwin"}}
```

**This is the finding.** `performAlertSweep()` reads live machine state through
`createIrisReadClient()`, which throws `IrisReadUnavailableError` when
`IRIS_READ_BASE_URL` / `IRIS_LAUNDRYTWIN_READ_API_KEY` are absent. Production has
**no** `IRIS_*` variable in the app's environment at all:

```text
docker inspect <app> --format '{{range .Config.Env}}...' | grep -oE '^[A-Z_]+='
→ ALERT_SWEEP_TOKEN, API_IMAGE, APP_IMAGE, BETTER_AUTH_*, BOT_*, CLICKHOUSE_*,
  CORS_ORIGIN, DATABASE_PATH, ETL_IMAGE, GAS_*, LAUNDRYTWIN_DEMO_MODE,
  LINE_*, MCP_*, NODE_*, PORT, WEATHER_*, WEB_IMAGE, WEB_ROOT
  (no IRIS_READ_BASE_URL, no IRIS_LAUNDRYTWIN_READ_API_KEY)
```

`LAUNDRYTWIN_DEMO_MODE=false`, so this is not demo mode masking a fallback, and
`/health` has reported `reportingConfigured: false` on every prior deploy — the
runbook calls that "the expected baseline … the optional read-only IRIS
integration production does not configure".

So the alert engine has never had a data source in production, and the sweep
inherits that. The schedule itself is proven — runs started at 10:20:00 and
10:25:00 to the second — and the guard is proven (401 without the token, 401
with a wrong one). What is not proven, and cannot be, is a sweep that evaluates
anything.

**The DAG is now paused** (`is_paused=t`, 10:27 UTC) so it does not write 288
failed runs a day while this is unresolved. Unpausing is one command once IRIS
exists; the schedule stays in the file either way.

## What is verified, and what is not

Verified: the image containing the route is what production serves (bundle hash
changed, LIFF id present); the route's token guard answers 401/404 correctly; the
DAG parses, fires on the 5-minute marks, reaches the endpoint over the docker
network and records the 503; the SQLite backup is a real WAL-safe backup of the
live database; the rollback image is on the host.

Not verified, and not claimable: a successful sweep, any alert rule firing, the
gas trend inside a production sweep, and R05/R06 closure. Nothing here says the
alert engine works — it says it is wired, scheduled, reachable, and starved.

## Open decision

`docs/superpowers/plans/2026-11-09-alert-sweep-source.md` — either configure the
IRIS read integration (owner supplies `IRIS_READ_BASE_URL` and
`IRIS_LAUNDRYTWIN_READ_API_KEY`), or give the sweep a warehouse-backed path that
does not need IRIS. The second changes the contract of R05 and belongs in its own
plan, not in this record.

## Rollback

```bash
cd /opt/laundrytwin
sudo APP_IMAGE=laundrytwin:deploy-4fb470d-20261109 docker compose up -d app
sudo docker exec analytics-airflow-scheduler-1 airflow dags pause laundrytwin_alert_sweep   # already paused
sudo systemctl stop laundrytwin-clickhouse-backup.timer   # only if the backup is also suspect
```

The SQLite backup at `/data/backup-predeploy-2026-11-09T093502370Z.sqlite` is the
data rollback for this deploy; restoring it means stopping the app and copying it
back over `/data/laundrytwin.sqlite` (and removing `-wal`/`-shm`).
