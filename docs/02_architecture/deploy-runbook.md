# 🚀 LaundryTwin Deployment Runbook (public edge + TLS)

**Scope:** how the deployed stack is reachable publicly, where TLS terminates,
and what to do when something breaks. This documents the current deployment
configuration and observed topology as of 2026-09-25. The TLS edge lives
outside the repo's OpenTofu module (see `deploy/tofu/README.md` out-of-scope
notes) — it is the home-lab Pi's job.

## Topology

```text
Internet
   │  *.laundrytwin.duckdns.org  →  161.246.5.47  (duckdns A records)
   ▼
Home-lab Pi  (Caddy — TLS edge, Let's Encrypt, HTTP→HTTPS)
   │  ZeroTier overlay (172.30.191.0/24)
   ▼
VM 117  (172.30.191.48, host "laundrytwin")
   ├─ laundrytwin-web-1        :8080  (nginx → SPA + /api/ → api:8787)
   ├─ laundrytwin-api-1        :8787  (Hono API + public MCP route `/mcp`)
   ├─ laundrytwin-etl-1        host   (batch ETL loop, IRIS Postgres → ClickHouse)
   ├─ laundrytwin-weather-1    host   (TMD weather collector loop, hourly)
   ├─ laundrytwin-gas-1        host   (Home Assistant gas-pressure collector, hourly; opt-in `profiles: ["gas"]`)
   ├─ laundrytwin-registry     :5000  (docker registry v2, htpasswd auth)
   ├─ analytics-superset-1     :8088  (Superset, fronted by Authentik SSO)
   ├─ analytics-airflow-webserver-1   :8081  (Airflow 3.x api-server — UI/API)
   ├─ analytics-airflow-scheduler-1   (scheduler, per-role service)
   ├─ analytics-airflow-triggerer-1   (triggerer, per-role service)
   ├─ analytics-airflow-dag-processor-1 (dag processor, per-role service)
   ├─ analytics-postgres-1     :5433  (Airflow + Superset metadata)
   ├─ analytics-clickhouse-1   :8123  (HTTP interface — ZeroTier only)
   ├─ analytics-redis-1        (Superset cache)
   ├─ analytics-mcp-inspector-1:6274  (local-only MCP Inspector; no public route)
   ├─ LibreChat                :3080  (chat.laundrytwin.duckdns.org)
   ├─ chat-mongodb / chat-meilisearch  (LibreChat metadata + search)
   └─ arcane                   (companion app)
```

## DNS (duckdns.org)

All hosts resolve to the same public IP (verified `dig`):

| Host | A record |
| :--- | :------- |
| `laundrytwin.duckdns.org` | 161.246.5.47 |
| `superset.laundrytwin.duckdns.org` | 161.246.5.47 |
| `airflow.laundrytwin.duckdns.org` | 161.246.5.47 |
| `mcp.laundrytwin.duckdns.org` | 161.246.5.47 |
| `chat.laundrytwin.duckdns.org` | 161.246.5.47 |
| `registry.laundrytwin.duckdns.org` | 161.246.5.47 |

Add/remove hosts at https://duckdns.org (token is per-domain; keep it in the
Pi's duckdns updater, not in this repo).

## Public host → service mapping

| URL | Backend on VM | Notes |
| :-- | :------------ | :---- |
| `https://laundrytwin.duckdns.org` | web :8080 | SPA + `location /api/` → api:8787 (in-stack nginx, `deploy/nginx.conf`); `location = /webhooks/line` → api |
| `https://superset.laundrytwin.duckdns.org` | superset :8088 | **Authentik SSO in front** — Caddy → Authentik outpost (`auth.notnotik.duckdns.org/application/o/authorize/...`) → superset. Only members of the `final project member` group can sign in. |
| `https://clickhouse.laundrytwin.duckdns.org` | analytics-clickhouse :8123 | **Authentik removed 2026-09-18.** Caddy `basic_auth` (`reader`) + least-privilege ClickHouse `reader` user (SELECT on `laundrytwin_analytics` only). Never point this route at the `admin` credential. |
| `https://airflow.laundrytwin.duckdns.org` | airflow-webserver :8081 | Airflow 3.x login (`admin` + `AIRFLOW_ADMIN_PASSWORD` from `/opt/analytics/.env`) |
| `https://mcp.laundrytwin.duckdns.org` | api :8787 `/mcp` | Public MCP route. Requires `MCP_ACCESS_TOKEN`; server-side scope/revenue controls apply. |
| `https://chat.laundrytwin.duckdns.org` | LibreChat :3080 | LibreChat UI; users/passwords in MongoDB db `LibreChat` (ops recipe: `references/librechat-ops.md`) |
| `https://registry.laundrytwin.duckdns.org` | registry :5000 | docker registry v2, htpasswd (user `laundrytwin`); **no double auth on Caddy** or `docker login` breaks |

## TLS / certificates (verified 2026-09-06)

- **Issuer:** Let's Encrypt (Caddy automatic HTTPS) — subjects are
  per-hostname (`CN=superset.laundrytwin.duckdns.org`, etc.).
- **Current expiry:** 2026-11-05 (Caddy renews automatically ~30 days before
  expiry; a `duckdns` challenge plugin is not needed because duckdns supports
  HTTP-01 through the Pi).
- **Renewal check:** `caddy list-modules | grep dns` on the Pi, or simply
  watch for expiry: `curl -vI https://laundrytwin.duckdns.org/ 2>&1 | grep -i expire`.

## Caddy config (reference — verify on the Pi)

The actual Caddyfile lives on the home-lab Pi (SSH key required; the key used
for VM 117 is **not** authorized there). Expected shape:

```caddyfile
laundrytwin.duckdns.org {
    reverse_proxy http://172.30.191.48:8080
}
superset.laundrytwin.duckdns.org {
    reverse_proxy http://172.30.191.48:8088
}
airflow.laundrytwin.duckdns.org {
    reverse_proxy http://172.30.191.48:8081
}
mcp.laundrytwin.duckdns.org {
    reverse_proxy http://172.30.191.48:8787
}
chat.laundrytwin.duckdns.org {
    reverse_proxy http://172.30.191.48:3080
}
registry.laundrytwin.duckdns.org {
    reverse_proxy http://172.30.191.48:5000
}
```

If Authentik is in front of Superset, replace the superset block with the
outpost's own proxy settings (Authentik outpost normally handles it).

The `mcp.laundrytwin.duckdns.org` host points to the API's authenticated
`/mcp` route. MCP Inspector remains local-only on VM 117 (`127.0.0.1:6274`) and
must not be exposed through Caddy. Use an SSH port-forward when inspecting it.
The inspector must not run with `DANGEROUSLY_OMIT_AUTH=true`.

The `clickhouse.laundrytwin.duckdns.org` block is intentionally NOT
Authentik-protected (changed 2026-09-18). Reference shape:

```caddyfile
clickhouse.laundrytwin.duckdns.org {
    import hide-server
    uri query -fbclid
    basic_auth {
        reader <bcrypt hash, kept only in this file on the Pi>
    }
    reverse_proxy 10.10.0.117:8123
}
```

The bcrypt hash and the matching ClickHouse plaintext live only on the Pi
(`basic_auth`) and VM 117 (`/opt/analytics/clickhouse-reader.local.xml`,
mode 600, git-ignored). The placeholder version in this repo is
`deploy/analytics/clickhouse-reader.xml`.

The privileged `admin` account is network-scoped, not password-only:
`deploy/analytics/clickhouse-admin-networks.xml` mounts into
`users.d/admin-networks.xml` and allows only `127.0.0.1` (host-networked
ETL/weather) and `172.16.0.0/12` (docker bridges + ZeroTier overlay).
`CLICKHOUSE_SKIP_USER_SETUP: 1` in `compose.yaml` stops the image entrypoint
from writing its own `admin` with `<ip>::/0</ip>` — two `users.d` files
defining the same user make ClickHouse fail every login with Code 516, so
`admin` must have exactly one definition. Public traffic arrives as
`10.10.0.1` (the VM LAN gateway) and is therefore denied; `reader` stays open.

## LINE LIFF login configuration

Login is the one flow that cannot be configured from this repository. The web
image bakes `VITE_LIFF_ID` at build time and the API verifies the ID token
against LINE using `LINE_LOGIN_CHANNEL_IDS` / `LINE_LOGIN_CHANNEL_ID`, but the
**scopes the LIFF app issues tokens under are a channel-console setting**, and
they are what actually decides whether login works.

**Required on the LIFF app** (LINE Developers Console → provider → channel →
**LIFF** tab → Scope, or for a LINE MINI App the **Web app settings** tab →
Scopes):

> **A LINE MINI App channel can be given the `openid` scope** — its *Web app
> settings* tab has a Scopes row with an Edit button, the same control a LIFF
> tab has. An earlier version of this file claimed the opposite, on the
> strength of LINE's published MINI App guide rather than the console; the
> console was checked on 2026-09-30 and the checkbox is there and editable.
> A MINI App is therefore a viable substitute for a LINE Login LIFF app, and
> the fix for a missing scope is one checkbox, not a new channel.

| Scope | Why it is needed | Symptom if missing |
| :-- | :-- | :-- |
| `openid` | The SDK issues an ID token only with this scope. The API verifies that token against `api.line.me/oauth2/v2.1/verify` — without it there is nothing to verify. | `isLoggedIn()` is true and the profile resolves, but the page fails with a missing-ID-token error. This is the confusing one: everything looks logged in. |
| `profile` | `liff.getProfile()` supplies the display name the gate shows. | The exchange has no display name to show. |
| `email` | Optional. Only for showing the user's email; the grant is a separate user consent. | Not required for login. |

**Diagnosing it from the browser console**, without reading the app's code:

```js
// LIFF app scopes — if "openid" is absent, it is a console setting.
liff.getContext()
// What this specific user has granted.
liff.permission.getGrantedAll()
```

`getContext()` and `getGrantedAll()` answer different questions: the first is
what the app is *configured* with, the second is what the user *agreed to*. A
scope can be enabled in the console and still be absent from the granted list
until the user re-consents — the fix there is to sign out and sign in again, not
to touch the console.

The page's own error message distinguishes the two cases: a missing app scope
names the console, a missing grant asks the user to re-consent, and if neither
list can be read it says so instead of guessing. That distinction exists because
an unreadable list and an empty list must not produce the same conclusion — one
is a config fix, the other is a consent fix.

**Measured 2026-09-30, from the production site's own LIFF SDK** (read in an
external Chromium, `liff.getContext()`), this is the state that produced the
missing-ID-token error:

```json
{ "liffId": "2011592166-uToRdTwS",
  "scope":  ["profile"] }
```

So `VITE_LIFF_ID` was baked into the image correctly and the SDK (2.22.0) loaded
from `static.line-scdn.net` without console errors — the scope set was the only
thing missing. `VITE_LIFF_ID` is `2011592166-uToRdTwS`, whose prefix is the first
entry of `LINE_LOGIN_CHANNEL_IDS`; that internal-channel shape identifies this as
a **LINE MINI App**. The server code is not the constraint — `parseChannelIds`
feeds every listed ID to the verifier as `client_id`, so both a MINI App's
internal channel and a LINE Login channel verify fine once a token exists.

**Fixed 2026-09-30** by ticking `openid` on that MINI App's Scopes row (Web app
settings) and pressing Update; the console then read `openid, profile`. No
channel was created and no image was rebuilt, because the LIFF ID is unchanged.
The same channel also lists `OPENID_CONNECT` under Basic settings →
Permissions, so the channel already had the capability and only the LIFF app
was missing the selection.

Two consequences worth knowing before testing:

- Adding a scope to an app users have already consented to does **not** update
  what those users granted. Anyone who signed in before this change has to
  re-open the app to see the consent screen again; until then
  `permission.getGrantedAll()` still lacks `openid` and the page asks them to
  re-consent.
- The MINI App is still `Unverified`. All three endpoint URLs — Developing,
  Review, and Published — now point at `https://laundrytwin.duckdns.org`; the
  Review and Published rows previously held LINE's placeholder pages, which
  would have sent reviewers to a static asset instead of the app. This means a
  LINE reviewer exercising the Review LIFF URL reaches production and sees real
  ClickHouse data, which is the normal and intended arrangement for a review
  submission. Privacy policy URL is still unset on Basic settings and is a
  separate review requirement.

**Verified 2026-09-30 in a real sign-in against production,** after the scope
change. The chain, as measured in the browser:

```text
liff.getContext().scope            ["openid","profile"]     (was ["profile"])
liff.permission.getGrantedAll()    ["profile","openid"]     user consented
liff.getIDToken()                  present
  iss                              https://access.line.me
  aud                              2011592166              == LINE_LOGIN_CHANNEL_IDS[0]
POST /api/auth/liff/exchange       403 ACCESS_PENDING
```

The `aud` claim matches a listed channel ID, which is the whole point of
`LINE_LOGIN_CHANNEL_IDS` — `parseChannelIds` tries each listed ID as `client_id`
against `api.line.me/oauth2/v2.1/verify`, and the MINI App's developing channel
verifies like any other.

`ACCESS_PENDING` is **not** an authentication failure. The token was accepted;
`findLiffUser` found no local identity for this LINE user, so the route recorded
a pending request and refused. That is the designed behaviour for an unknown
LINE account, and the web gate renders the Thai pending card for it. To finish,
an owner must approve the request from the access-grants screen (it lists
`liffAccessRequest` rows) — the same screen that issues branch-scoped grants.

**Not established here:** no completed session yet. The flow is verified up to
and including token verification and the pending-request response; it has not
been observed past an approval into an authenticated dashboard, because the
test account has no grant. Do not describe LINE login as working end to end
until a real sign-in has landed on `/dashboard`.

## Operational notes

- **ZeroTier is load-bearing:** the Pi reaches the VM over 172.30.191.0/24.
  If the VM drops off ZeroTier, all public hosts go down even though the
  containers are healthy. First check: `zerotier-cli listpeers` on the Pi and
  `sudo zerotier-cli status` on the VM.
- **Demo mode is preview-only:** keep `LAUNDRYTWIN_DEMO_MODE=false` for the
  production environment. A non-development preview may enable it only when an
  explicit `laundrytwin_demo_session` cookie is issued; it is not a
  production-by-design mode and never replaces unavailable real data. The
  browser must never receive upstream credentials (AGENTS.md boundary).
- **ClickHouse credentials are separated by workload:** API/analytics read
  queries render with `CLICKHOUSE_USER=reader` and `CLICKHOUSE_PASSWORD` filled
  from the required `clickhouse_reader_password`; ETL uses the admin
  `CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD` pair because it writes the warehouse.
  Both are server-side secrets. Do not put the admin password in the API or
  browser environment.
- **Production MCP flags:** set a random `MCP_ACCESS_TOKEN` and keep
  `MCP_ALLOW_REVENUE=false` unless revenue access is explicitly approved. The
  MCP inspector is local-only and is not the public MCP service.
- **Weather cadence:** the TMD collector runs hourly with `sleep 3600` and
  tags observations by `tenant_id/branch_id`.
- **No TLS inside the stack:** `deploy/nginx.conf` listens on :80 only; TLS
  terminates on the Pi. Do not add TLS to the in-stack nginx.
- **Registry pull from the VM:** the VM cannot reach the registry via the
  public duckdns IP (NAT loopback fails) — compose pulls use the internal
  `127.0.0.1:5000` (daemon.json allowlists it as insecure). The Mac pushes via
  `registry.laundrytwin.duckdns.org`.
- **Airflow is per-role services since 2026-09-13:** `airflow standalone`
  does not respawn a crashed scheduler; each role now runs as its own
  container with `restart: unless-stopped`. Health:
  `curl http://127.0.0.1:8081/api/v2/monitor/health` (all of
  metadatabase/scheduler/triggerer/dag_processor should be healthy with fresh
  heartbeats). Metadata lives on `analytics-postgres-1` (db `airflow`), and
  Superset metadata on the same Postgres (db `superset`).
- **SSH access:**
  - VM 117: `ssh uunw@172.30.191.48` (key-based, `sudo` passwordless).
  - Pi: SSH is open on 192.168.88.10 but requires the Pi's authorized key —
    ask the machine owner for access before changing the Caddyfile.

## Production rollout gate

LaundryTwin has two deployment tiers: local (env files plus the `dev` run mode)
and production on the existing VM 117 documented in `Topology` above. `dev` is
a local run mode, not a deployed environment. There is no staging environment,
and no staging rollout should be planned or described.

Run this gate for any production apply, and only after the production target,
approved application ref, and rollback ref are recorded in the change ticket.
Do not use `main`, a local working tree, or an uncommitted image as the
deployment ref.

### Before apply

1. Record the current deployed app ref and analytics configuration as `<last-known-good-ref>`.
2. Confirm the target is the production VM above and that the change is inside
   the approved scope. Production deployment, production migration, and live
   machine actions require separate explicit approval.
3. Back up the app SQLite database, ETL watermark, and analytics volumes before changing the stack.
4. Verify all required Tofu variables are supplied through an untracked `terraform.tfvars` or `-var-file`; never put values in this repository. `airflow_db_password` is required in addition to the existing Airflow/Superset/ClickHouse secrets.
5. Run `tofu fmt -check`, `tofu validate`, and `tofu plan` from `deploy/tofu`. Review the plan for app, ETL, ClickHouse, Airflow, and Superset changes.
6. Run `docker compose -f deploy/analytics/compose.yaml config --quiet` with the target env values available locally or on the VM. Resolve missing-variable warnings before apply.

### Apply and smoke

1. Set `app_repo_ref` to the approved immutable commit or tag and run `tofu apply` once.
2. Check `sudo docker compose -f /opt/analytics/compose.yaml ps` and confirm ClickHouse, Postgres, Airflow roles, Superset, Redis, and API/web are healthy.
3. Check `http://127.0.0.1:8787/health`, `http://127.0.0.1:8080/`, and `http://127.0.0.1:8088/health` on the VM.
4. Verify an unauthenticated report request is denied, an approved session is branch-scoped, invalid calendar dates return `400`, and logout revokes the session.
5. Verify the ClickHouse reader can query the analytics database and cannot use the admin credential from the API or browser.
6. Verify public TLS routes only after internal smoke passes. Keep the MCP inspector local-only and keep `MCP_ALLOW_REVENUE=false` unless separately approved.

### Rollback

1. Stop further rollout steps and preserve logs, container status, and the failed application ref.
2. If the application ref is the cause, re-run `tofu apply` with `app_repo_ref=<last-known-good-ref>`. Do not delete volumes or run `docker compose down -v`.
3. If a schema or data migration is involved, restore the recorded app SQLite, ETL watermark, and analytics backups only after confirming the target backup and migration compatibility.
4. Re-run the internal health, auth, branch-scope, ClickHouse-reader, Airflow, and Superset smoke checks. Record the result in the change ticket before closing the incident.

This gate documents how a production change is made; it does not authorize
one. Any production deployment, production migration, live telemetry ingestion,
machine command, or payment write requires a separate explicit user request,
the recorded rollback ref, and the post-change smoke checks above.

## ETL incident 2026-09-25 — the four-day silent hang

`laundrytwin-etl-1` stopped loading at 2026-09-25 12:21 UTC and produced no
error for four days. The evidence was the shape of the silence, not a message:
the `while true; do node src/index.ts; sleep 300; done` wrapper was still
alive, its `node` child had consumed **4 s of total CPU**, `RestartCount=0`, and
`docker logs` held nothing but successful `ETL complete:` lines. A blocked
Postgres statement looks exactly like that.

### What was wrong, on the IRIS side

The temperature read paginated on `(ingested_at, seq, event_id)`. In IRIS
(`Meepain-group/iris-project` at `813ffa7`):

| Fact about `machine_temperature_sample` | Consequence for that read |
| :--- | :--- |
| `PARTITION BY RANGE (occurred_at)` | A predicate on `ingested_at` prunes nothing; every page touched every partition. |
| Indexed on `occurred_at` (migration `0030`), **no index on `ingested_at` in any of the 203 migrations** | The keyset could not be served by an index. |
| ~210 rows per cycle per dryer, **no retention** (IRIS's rotate cron covers `machine_event` only; `0030` deferred this table to a follow-up that never happened) | The scan grew monotonically, so a run that worked slowly eventually stopped finishing at all. |

`machine_usage` was exonerated and is unchanged: at roughly 8,000 rows over
roughly 70 calendar days (the current figure is in
`docs/06_ml/ml-training-data-guide.md` §5) its keyset is trivial. (It has no
index on `created_at` either — only `(branch_id, created_at)`, `(machine_id)`,
`(member_id)` — which is a comment, not a defect, at that size.)

### What changed in this repository (2026-09-29)

- The temperature read keys on `occurred_at` — indexed and the partition key —
  with the same strict `(seq, event_id)` tie-breakers, inside a range bounded by
  `ETL_TEMPERATURE_LAG_HOURS`. Full detail in `apps/etl/README.md`.
- Every source and warehouse request is bounded
  (`ETL_PG_STATEMENT_TIMEOUT_MS=180000`, `ETL_PG_CONNECT_TIMEOUT_MS=10000`,
  `ETL_PG_IDLE_IN_TX_TIMEOUT_MS=30000`, `ETL_CH_REQUEST_TIMEOUT_MS=120000`) and
  every phase is logged with a budget (`ETL_PHASE_TIMEOUT_MS=900000`).
- `docker logs` now carries `ETL run start …`, `ETL phase=<name> status=start`,
  per-batch progress, and `status=failed` lines. A future hang names its phase
  without a debugger.

### Watermark migration, and the one manual step it may need

`temperature.at` is now `occurred_at` and carries `"key": "occurred_at"`. A
watermark written before the change is **not** reinterpreted — that would skip
every row between the two positions. On the first run after the change the ETL
issues one re-anchor query (the last row at or before the old `ingested_at`
position) and persists the result. That query is a full scan by construction, so
it gets a 10-minute server-side budget. If it cannot finish:

1. Look for `ETL temperature=cursor-migrate` in `docker logs`.
2. Pin the boundary instead: set `ETL_TEMPERATURE_SINCE_ISO` to the last
   `occurred_at` you know was loaded, and re-run. This **re-reads** everything
   after that instant, and `fact_temperature_sample` is a plain `MergeTree`, so
   a re-read inserts duplicates. Choose the instant deliberately.
3. Removing the watermark file entirely is the worst option: it falls back to
   `ETL_SINCE_FALLBACK_DAYS`, which the Terraform default sets to 30.

### Upstream fixes LaundryTwin cannot make

These live in the IRIS repository. Until they land, the ETL works around them;
recording them here so they are not lost.

1. **No index on `machine_temperature_sample.ingested_at`**, and therefore no
   partition pruning available for it. Anything else that reads that table by
   ingest time has the same exposure.
2. **No `2026_10` partition.** Partitions exist only for 2026_05 … 2026_09 and
   nothing rotates them. From 2026-10-01 IRIS will stop recording temperature
   with `no partition of relation … found for row` (failure mode stated in
   migration `0030:81-82`).
3. **No retention for `machine_temperature_sample`.** The rotate cron only
   covers `machine_event`; the follow-up `0030` promised for this table never
   happened, so the table is unbounded.
4. **`ETL_SINCE_FALLBACK_DAYS` is 0 in code and in `apps/etl/.env.example`, but
   the deployed Terraform default is 30** (`deploy/tofu/variables.tf`,
   `etl_since_fallback_days`). Check the real value in
   `/opt/laundrytwin-etl/.env` before assuming either. The combination to avoid
   is a 30-day fallback *and* a lost watermark: the temperature read then
   restarts 30 days back, and although it is now an index range instead of a
   full scan, it still walks a large window in one run.

### The measurement this change still owes

The change is justified by the IRIS schema facts above, **not by a measured
query-time improvement in this repository.** No IRIS Postgres is reachable from
a development machine, and the local warehouse cannot stand in for it: the
synthetic `fact_temperature_sample` there has 8,867 rows whose `ingested_at`
never deviates from `occurred_at` (max observed lag 6 s), so a keyset on either
column selects the same rows and both query shapes read the same 3,594 rows.
**Those two figures describe the LOCAL synthetic warehouse only** and must not be
compared with the production warehouse, which holds **3,760,465 rows** spanning
2026-05-26 15:51:50.633 → 2026-09-29 11:37:18.725 (measured 2026-09-30
11:39:11 UTC) — and which carries **1,503,920 duplicate sort keys** over
2,256,545 distinct `(tenant_id, branch_id, occurred_at, event_id)` tuples,
because the table is a plain `MergeTree` with no de-duplication. See
`docs/04_traceability/ops-verification-2026-09-30-warehouse-data-recovery.md`.

Whoever holds the `reader` credential (see the credential table below) should
run the old and the new statement against the real
`machine_temperature_sample` in **IRIS Postgres** (~3.5M rows,
2026-05-26 → 2026-09-25, as of 2026-09-25 — **not re-measured on 2026-09-30**)
for a comparable window, and record `read_rows` / `read_bytes` /
elapsed for each plus `EXPLAIN (ANALYZE, BUFFERS)` showing the plan no longer
visits every partition:

```sql
-- old shape: keyset on the unindexed column
SELECT ... FROM machine_temperature_sample s
WHERE (s.ingested_at, s.seq, s.event_id) > ($1, $2, $3)
ORDER BY s.ingested_at, s.seq, s.event_id LIMIT 20000;

-- new shape: keyset on the indexed partition key, bounded above
SELECT ... FROM machine_temperature_sample s
WHERE s.occurred_at >= $1
  AND (s.occurred_at, s.seq, s.event_id) > ($1, $2, $3)
  AND s.occurred_at <= $4
ORDER BY s.occurred_at, s.seq, s.event_id LIMIT 20000;
```

## Read-only warehouse diagnostic: cycle cardinality

`apps/api/scripts/cycle-cardinality-diagnostic.ts` is a SELECT-only script that
measures two facts about `fact_machine_usage`: how many rows one real IRIS
`machine_session_id` spans, and whether one session id can carry more than one
`status`. Four surfaces used to render a number labelled "รอบ" (cycle) and none
of them agreed. **This was decided on 2026-09-29, from a real-warehouse run of
this script**: the canonical cycle count is the paid/finished **row** count.
The decision, its evidence, and the ฿/cycle plausibility band are recorded in
`docs/04_traceability/RTM_matrix.md` ("Canonical cycle definition").

Running the script still changes nothing in the stack; this section documents
how to reproduce the finding, not how to re-open the question.

The script filters to non-synthetic rows
(`NOT startsWith(source_event_id, 'synthetic:')`) and **refuses to print a
verdict when there are none**, exiting `1` with `VERDICT: REFUSED`. A seeded or
empty warehouse therefore cannot produce a number that could be mistaken for a
finding about IRIS.

### What this repository documents about the connection

| Fact | Value | Where it is documented |
| :--- | :---- | :--------------------- |
| Warehouse host | VM 117, `172.30.191.48` over ZeroTier, host `laundrytwin` | `Topology` above |
| ClickHouse service | container `analytics-clickhouse-1`, image `clickhouse/clickhouse-server:26.3` | `deploy/analytics/compose.yaml` |
| HTTP port | `8123:8123`, published on all host interfaces; internal health check on `127.0.0.1:8123/ping` | `deploy/analytics/compose.yaml`, `deploy/analytics/clickhouse-listen.xml` |
| Database | `laundrytwin_analytics` | `deploy/analytics/clickhouse-reader.xml`, `apps/etl/src/schema.ts` |
| Credential to use | user `reader`; `GRANT SELECT ON laundrytwin_analytics.*` only, `access_management` off, INSERT/DDL denied | `deploy/analytics/clickhouse-reader.xml` |
| Where the `reader` password lives **on the VM** | `/opt/laundrytwin/.env` as `CLICKHOUSE_PASSWORD` (app env) and `/opt/analytics/.env` as `CLICKHOUSE_PASSWORD` (analytics env), both installed mode 0600 from the untracked `clickhouse_reader_password` Tofu variable | `deploy/tofu/locals.tf` (`app_env`, `analytics_env`), `deploy/tofu/envfiles.tf`, `deploy/tofu/variables.tf` (`app_install_dir` default `/opt/laundrytwin`, `analytics_install_dir` default `/opt/analytics`) |
| Public ClickHouse route | `https://clickhouse.laundrytwin.duckdns.org` → Caddy `basic_auth` + ClickHouse `reader` | `Public host → service mapping` and `Caddy config` above |

Use `reader`, not `admin`. `admin` is network-scoped to `127.0.0.1` and
`172.16.0.0/12` and the script needs nothing beyond `SELECT`, so `reader` is
both sufficient and the correct least-privilege choice.

### The command

From a checkout of this repository, on any machine that can reach the
ClickHouse HTTP interface:

```bash
cd apps/api
CLICKHOUSE_URL=http://<host>:8123 \
CLICKHOUSE_USER=reader \
CLICKHOUSE_PASSWORD='<reader password, see below>' \
CLICKHOUSE_DATABASE=laundrytwin_analytics \
pnpm exec tsx scripts/cycle-cardinality-diagnostic.ts
```

Optional flags narrow the measurement to a window or a branch, matching the
empty-string sentinel used by the analytics queries:

```bash
pnpm exec tsx scripts/cycle-cardinality-diagnostic.ts \
  --from=2026-09-01 --to=2026-09-28 [--branch=<branch uuid>]
```

`apps/api/src/config.ts` loads the git-ignored repository-root `.env` on
import, so exporting `CLICKHOUSE_*` inline is what selects the target — dotenv
does not overwrite variables already present in the environment. Passing a
`CLICKHOUSE_URL` that cannot be reached fails with `ClickHouse is unreachable`
rather than silently falling back to a local warehouse.

Read the whole output before quoting any line from it. The header states the
row counts, and `real_rows=0` with `VERDICT: REFUSED` means the run tells you
nothing about IRIS.

### What this repository does NOT document — the operator must supply it

The following are deliberately absent from the repo and must be obtained out of
band. Do not add them to this document or to any tracked file.

1. **The `reader` password value.** It exists only on VM 117, in the git-ignored
   `/opt/analytics/clickhouse-reader.local.xml` that ClickHouse authenticates
   `reader` against today (per the `Caddy config` section above), and as the
   bcrypt hash in the Pi Caddyfile. It is **not** a Tofu-managed value yet —
   Tofu has never been applied to this host, so `/opt/analytics/.env` has no
   `CLICKHOUSE_READER_PASSWORD` key (verified 2026-09-30 by reading key names
   only, no value), and its `CLICKHOUSE_PASSWORD` is the **admin** secret: a
   different credential with broader reach. Never take the value from
   `/opt/analytics/.env` for `clickhouse_reader_password`; that is how an admin
   credential silently becomes the public reader login. The first apply puts the
   same value into `/opt/laundrytwin/.env` as the API's `CLICKHOUSE_PASSWORD` and
   into `/opt/analytics/.env` as `CLICKHOUSE_READER_PASSWORD`. Retrieve the
   plaintext over the documented SSH access and export it into the shell for the
   run; do not paste it into a ticket, a commit, or a shell history that is
   shared. The repo ships only the placeholder
   `deploy/analytics/clickhouse-reader.xml`, which takes the password
   `from_env`.
2. **A reachable hostname for the HTTP interface from the operator's machine.**
   The runbook documents the ZeroTier address `172.30.191.48`, the public
   hostname `clickhouse.laundrytwin.duckdns.org`, and the `8123:8123` host
   binding, but not which of them the operator's current network can reach. An
   SSH port-forward (`ssh -L 8123:127.0.0.1:8123 uunw@172.30.191.48`, then
   `CLICKHOUSE_URL=http://127.0.0.1:8123`) works over the documented
   key-based SSH access as long as ZeroTier is up; the forward itself is not a
   documented procedure and is offered here as a route, not as a verified step.
3. **How the `reader` password is used at the public route.** Caddy
   `basic_auth` sits in front of the ClickHouse reader there, and the Caddyfile
   lives only on the Pi, so this repository does not state whether the same
   credential is valid at both hops. Confirm on the Pi before relying on the
   public route; the port-forward route above avoids the question entirely.
4. **Whether the API and analytics containers can be reached for this run.**
   The script is standalone and needs only ClickHouse, so this is listed only
   so no one assumes a running API is required. It is not.

### After the run

Read the output against the finding already recorded in
`docs/04_traceability/RTM_matrix.md` ("Canonical cycle definition"). Compare
the **ranking** of the four definitions, not a single ฿/cycle value. A run that
reproduces `1 row per session` and `0 multi-status sessions` **and** keeps the
row count closest to a real wash while the session-distinct counts stay several
times above it reproduces the decision. A run that does **not** is
new evidence: the attribution gap upstream may have changed, and the finding
needs re-deciding on the new numbers rather than being assumed still valid.

> **Do not use "฿/cycle is in ฿40–45" as the pass condition.** It passed on
> 2026-09-29 (฿42.20) and the decision was taken there, but the same query on
> the post-merge corpus reads **฿48.40** (measured 2026-09-30 11:39:11 UTC),
> above the band, on the canonical row count. That figure moves with the
> unattributed share as the ETL ingests the IRIS backlog and as merges land, so
> it is a weak gate. The cardinality result is the stable one. Quote any ฿/cycle
> value with its measurement date.

The diagnostic itself deliberately changes no query, type, label, or KPI, so no
number in the product moves as a result of running it.

## Troubleshooting quick reference

| Symptom | Likely cause | Check |
| :------ | :----------- | :---- |
| Public hosts down, ZeroTier IPs up | Pi ↔ VM ZeroTier link | `zerotier-cli listpeers` (Pi), `sudo zerotier-cli status` (VM) |
| One host 502 | That container down | `sudo docker ps` on VM; `sudo docker compose -f /opt/analytics/compose.yaml ps` |
| Cert expired | Caddy renewal blocked (HTTP-01 needs port 80 through) | `curl -vI ... \| grep -i expire`; Pi Caddy logs |
| LINE login fails with a missing-ID-token error, though the user is clearly signed in | The LIFF app has no `openid` scope, so LINE issues no ID token. A console setting, not a server or env one. | `liff.getContext()` in the LIFF browser console — see [LINE LIFF login configuration](#line-liff-login-configuration). If `openid` *is* there, check `liff.permission.getGrantedAll()` and have the user sign out and back in. |
| Superset login loops | Authentik outpost / group membership | `auth.notnotik.duckdns.org` reachable; user in `final project member` |
| App shows demo data | Explicit preview mode with demo session cookie | `https://laundrytwin.duckdns.org/health` → `"demoMode":true`; check `LAUNDRYTWIN_DEMO_MODE` and preview-only intent |
| Airflow DAGs not running | Scheduler heartbeat stale | `curl http://127.0.0.1:8081/api/v2/monitor/health` — restart the stale role container |
| Airflow restarts on its own, or `psycopg2.OperationalError: server closed the connection unexpectedly` | **Not an Airflow fault.** A Postgres *backend* died, so the postmaster tore down and reinitialized the whole cluster (~20–30 s, every connection refused) and `unless-stopped` restarted Airflow. | `docker logs analytics-postgres-1 \| grep -c "reinitializing"` for the count, and `grep -E "was terminated by signal\|exited with exit code"` for the cause line. 59 such events happened 2026-09-06→09-30 and the trigger was never identified. Connection logging is now on with `app=%a client=%h` in the prefix, so the next one names its client. **Do not record it as benign.** See `docs/04_traceability/ops-verification-2026-09-30-postgres-cluster-reinit-forensics.md`. |
| `database is locked` anywhere | SQLite metadata (should be gone) | Airflow + Superset metadata must live on analytics-postgres-1 |
| docker login to registry fails | Double auth on Caddy | Caddy block for registry must NOT add basic_auth |
| `laundrytwin-etl-1` alive, no new `ETL complete:` line | A source or warehouse call is blocked | `docker logs laundrytwin-etl-1 --tail 50` — the last `ETL phase=<name> status=start` names the phase; a phase with no `status=ok` is the one that stalled. Bounded timeouts now turn a real block into `status=failed` within `ETL_PHASE_TIMEOUT_MS`. |
