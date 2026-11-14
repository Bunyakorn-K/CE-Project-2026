# Superset unreachable: two defects behind one symptom (2026-11-13)

**Status: both defects fixed on VM 117. Browser rendering after the fix is
confirmed by the owner; SSO is still not single sign-on.**

The report was "Superset is unusable". The container was never down. Two
independent defects sat in series, and the second was only reachable once the
first was cleared:

1. **The `admin` password in the metadata database was not the password anyone
   held**, so the local login could never succeed.
2. **The metadata security model was never created**, so once a login did
   succeed *every* `/api/v1/*` call answered `403 {"message":"Forbidden"}`,
   `/api/v1/me/` included, and the welcome page rendered as six red
   "There was an issue fetching your dashboards: [object Response]" cards.

## What was ruled out first

| Check | Result |
|---|---|
| `analytics-superset-1` | `Up 5 weeks (healthy)`, image `laundrytwin-superset:6.1.0-clickhouse` |
| `GET 127.0.0.1:8088/health` | `200 OK` |
| `GET 127.0.0.1:8088/login/` | `200`, 15,014 B |
| `https://superset.laundrytwin.duckdns.org/` | `302` → `auth.notnotik.duckdns.org/application/o/authorize/…` → Authentik login page `200` |
| VM load / memory | 11.9 GB total, 6.9 used — not starved |

So the ingress, the certificate, the Authentik outpost and the Superset process
were all working. The failure was inside Superset's own authentication.

## Defect 1 — the admin password was not the one in `.env`

`ab_user` held exactly one account, and it had **never** been logged into:

```
 id | username |          email          | active | fail_login_count | last_login
  1 | admin    | admin@laundrytwin.local | t      |                5 |
```

`last_login IS NULL` is the decisive fact: no successful login since bootstrap.
Live traffic confirmed attempts were being made and rejected — four
`POST /login/?next=%2Fsuperset%2Fwelcome%2F` requests between `08:10:20` and
`08:11:12Z`, each answering `302` straight back to `/login/`.

The repository says the Superset admin password is `AIRFLOW_ADMIN_PASSWORD`
(`docs/superpowers/specs/2026-08-08-analytics-deployment-mapping.md:47`), which
is what `/opt/analytics/.env` holds (24 characters). It did not match. Compared
inside the container, the password read from the file on the box and passed in
as a variable — never printed, in either direction:

```
input_len=24  hash_prefix=scrypt:32768:8:1  match=False
```

**Fix:** `superset fab reset-password --username admin`, the value read from
`/opt/analytics/.env` on the host. Verification, three independent ways:

```
check_password_hash(hash, env_value)     -> True
security_manager.auth_user_db('admin', …) -> admin
ab_user                                   -> fail_login_count = 0,
                                             last_login = 2026-11-13 08:19:04.862176
```

## Defect 2 — `superset init` had never run against the Postgres metadata DB

With the password working, the browser reached `/superset/welcome/` and every
API call returned `403` with a 24-byte body — `{"message":"Forbidden"}`, on
`/api/v1/me/`, `/api/v1/dashboard/`, `/api/v1/chart/`, `/api/v1/saved_query/`,
`/api/v1/database/`, `/api/v1/log/recent_activity/`.

`/api/v1/me/` requires no role, so a 403 there is not a scoping decision — it
means the permission rows the endpoint checks do not exist. Measured:

| table | before | after |
|---|---|---|
| `ab_permission_view` | 27 | **231** |
| `ab_view_menu` | 15 | **99** |
| `ab_permission` | 8 | **86** |
| `ab_permission_view_role` | 4 (Admin) | **450** |
| roles | `Admin`, `Public` | `Admin`, `Alpha`, `Gamma`, `Public`, `sql_lab` |

`docker exec analytics-superset-1 superset init` (49.7 s) synced role
definitions, created the missing datasource and database permissions, and
cleaned faulty perms. Same probe afterwards:

```
LOGIN: 302 /
GET /api/v1/me/                    -> 200  {"result":{"username":"admin", …}}
GET /api/v1/dashboard/?q=(page_size:1) -> 200  {"count":1, "ids":[2], …}
```

**Root cause in the repository, not only on the box.**
`deploy/analytics/bootstrap-superset.sh` ran `superset db upgrade` and then
hand-granted four `can_write` permissions to `Admin` with a comment calling
`superset init` "incomplete during first boot". On a fresh SQLite volume the
app builds the security model on first boot, which hid the omission; after the
metadata DB moved to Postgres (`60268d7`), nothing did. The script now runs
`superset init` between `create-admin` and the four-permission safety net, so a
rebuilt host cannot reproduce this. `bash -n` clean; no test suite covers this
script.

## What is verified, and what is not

- **Verified:** container health and static routes; the Authentik gate passes a
  real browser; the reset credential authenticates and resets the failure
  counter; `superset init` took the API from `403` to `200` on six endpoints,
  measured with the application's own test client inside the container.
- **Not verified by the agent:** the rendered welcome page and dashboard in a
  browser after the fix — signing in needs the owner's account, which was not
  requested or handled. The owner's own check is the evidence for rendering.
- **Still outstanding:** Superset is **not** single sign-on. Caddy's
  `(authentik-protect)` snippet already copies `X-authentik-username`
  (`/etc/caddy/Caddyfile` on DietPi, lines 39–46) but `superset_config.py` sets
  no `AUTH_TYPE`/`ENABLE_PROXY_FIX`, so the header is discarded and a second,
  local login is required. The runbook table claimed "Authentik SSO in front"
  and has been corrected.

## Defect 3 — the dashboard carried a duplicate legacy layout

Once the API answered, the dashboard still looked broken: at the top sat a block
of eight narrow cards, every one titled *"Launc…"* and clipped, above the real
grid. Their owner caption read "LaundryTwin" on all of them.

The cause is in `dashboards.position_json` for dashboard `2`, not in the charts.
The grid held **two layouts at once**:

```
GRID_ID.children = ['ROW-1', 'ROW-2', 'ROW-3', 'ROW-4', 'ROW-N-Z6UFMKNR', 'ROW-N-VV47P66T']
```

`ROW-1`…`ROW-4` were seed-import leftovers holding `CHART-1a2b3c4d-…` style nodes
with `chartId` 1–7, `meta.sliceName = "LaundryTwin"` and **no `width`/`height`**,
so they rendered as narrow auto-sized cards. `HEADER_ID` was also orphaned —
`ROOT_ID.children` was `['GRID_ID']` only. The real layout is the two `ROW-N-*`
rows with all eight charts at `width=4`.

**Fix:** `PUT /api/v1/dashboard/2` with the four legacy rows, their seven chart
nodes and the orphan header removed — nothing else touched. The API does the
cache invalidation, which a raw SQL update would not.

- Backup of the pre-change `position_json`:
  `/opt/analytics/dash2_position_backup-20261113.json` (5,510 B,
  md5 `8bd3308860b874b9afe4326b4fff8102`).
- After: `GRID_ID.children = ['ROW-N-Z6UFMKNR', 'ROW-N-VV47P66T']`,
  `dashboard_slices` still `[1..8]` — **no chart was detached**, only the
  duplicate positions were dropped.

**Verified in a real browser** (Chromium, 1400×1000, session minted server-side
so no credential was typed): eight cards with their real titles, "Waiting on"
count `0`, `canvas` 7 / `svg` 30, the Top 10 table reading `D4 273 12.9k 30.65`,
`D9 265 12.3k 34.62`, and the utilization heatmap and weather line drawn.

Two things this did **not** fix: `ROW-N-Z6UFMKNR` still holds seven charts at
`width=4` each (28 of 12 grid columns), so they wrap three-per-line inside one
row rather than forming deliberate rows; and the *Revenue by Attribution* card
renders blank while its query answers 200 — both are graphical/content
questions, not the layout duplication above.

## Rollback

- Password: `superset fab reset-password --username admin` with the previous
  value. The previous value was unknown and unused (`last_login` was NULL), so
  there is nothing to restore.
- `superset init` is additive and idempotent; there is no rollback and none is
  needed. It does not touch dashboards, charts, datasets or the ClickHouse
  connection.
- `bootstrap-superset.sh`: revert the `1a/4` block.
