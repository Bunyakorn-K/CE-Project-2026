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
   ├─ laundrytwin-app-1        :8787  (Hono API + SPA static routes + public MCP route `/mcp`)
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
| `https://laundrytwin.duckdns.org` | app :8787 | One container serves the SPA and the API. The static half is `apps/api/src/spa.ts`; the in-stack nginx that used to proxy `/api/` was removed in the merge. |
| `https://superset.laundrytwin.duckdns.org` | superset :8088 | **Authentik SSO in front** — Caddy → Authentik outpost (`auth.notnotik.duckdns.org/application/o/authorize/...`) → superset. Only members of the `final project member` group can sign in. |
| `https://clickhouse.laundrytwin.duckdns.org` | analytics-clickhouse :8123 | **Authentik removed 2026-09-18.** Caddy `basic_auth` (`reader`) + least-privilege ClickHouse `reader` user (SELECT on `laundrytwin_analytics` only). Never point this route at the `admin` credential. |
| `https://airflow.laundrytwin.duckdns.org` | airflow-webserver :8081 | Airflow 3.x login (`admin` + `AIRFLOW_ADMIN_PASSWORD` from `/opt/analytics/.env`) |
| `https://mcp.laundrytwin.duckdns.org` | app :8787 `/mcp` | Public MCP route on the same container as the app; the path is what separates them, not the port. Requires `MCP_ACCESS_TOKEN`; server-side scope/revenue controls apply. |
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
    reverse_proxy http://172.30.191.48:8787
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
  submission.
- **Privacy policy URL is now set** (2026-09-30) to
  `https://laundrytwin.duckdns.org/privacy`, verified by reloading Basic
  settings and reading the row back, not by trusting the form's own success
  state. It matches the existing Terms of use row
  (`https://laundrytwin.duckdns.org/terms`) and is a **required** Basic
  settings field — the console rejects an empty value. Before publishing that
  URL, the page itself was loaded with cookies and localStorage cleared, which
  confirmed the route renders the real Thai policy for an outside visitor.
  That check also exposed a caveat, below.

  `/privacy` and `/terms` were inside the LIFF gate, so a signed-in-but-ungranted
  visitor saw the Thai "pending approval" card instead of the policy. **Fixed
  2026-10-01:** `LiffGate` now reads the current path and renders its children
  unconditionally on those two routes (`isUngatedPath` in
  `apps/web/src/lib/components/liff-gate.tsx`). The LIFF exchange effect still
  runs on them — only the blocking UI is skipped — so a visitor who reads the
  policy first is already exchanged by the time they sign in.

  The gate deliberately stays **above** `RouterProvider` rather than becoming a
  route layout. `_authenticated`'s `beforeLoad` fetches `/api/me` and redirects
  on 401, and `beforeLoad` runs before any effect; moving the exchange into the
  route tree would fire that fetch before the session cookie existed, and every
  legitimate first sign-in would bounce to `/login`. Because the gate is above
  the provider it cannot use `useRouterState`, so the path comes from the router
  instance's `latestLocation` (populated in the constructor, so it is correct on
  the first render) plus a `subscribe("onResolved")` listener.
- **English localization is set** (2026-09-30): Basic settings →
  Localization now carries one row, `English / LaundroTwin / Multi-branch
  smart laundry management dashboard — live machine status, revenue, and
  analytics.` The console requires English before a review can be requested,
  and the row was read back after a hard reload to confirm it persisted. Only
  English was added; the region is Thailand, so the Thai text still lives in
  Basic settings → Channel name/description, which is what a Thai-language
  LINE client sees.

**Verification is blocked for a reason no console setting can fix.** The Review
request tab does not offer a submit path at all; it states only:

> Your LINE MINI App is unverified. […] Notes: If the region to provide the
> service is Thailand or Taiwan, only certified providers can apply for the
> verification review.

Channel `2011592166` is a **LINE MINI App** with Region to provide the service =
Thailand, and its provider is a plain one (not LINE certification). The
endpoint URLs, privacy policy, and English localization set above are all
necessary for a review but **not sufficient to submit one**. Either the channel
must be created under a LINE-certified provider, or it must stay `Unverified`
and be operated as an unverified MINI App. Do not describe the channel as
review-ready or verified.

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
- **No TLS inside the stack:** the app listens on :8787 in plain HTTP; TLS
  terminates on the Pi. The in-stack nginx that used to sit in front was
  removed when the SPA moved into the API process — do not reintroduce a
  TLS-terminating proxy inside the stack.
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
  - VM 117: `ssh uunw@172.30.191.48` (key-based, `sudo` passwordless). This
    address is only reachable over the ZeroTier overlay.
  - **VM 117 from a host without ZeroTier** (measured 2026-10-01): the VM is
    also reachable on its LAN address `10.10.0.117`, and a host that can route
    to that LAN can jump in:
    ```bash
    ssh -J notnotik-pve uunw@10.10.0.117
    ```
    The `-J` is load-bearing. Running the inner `ssh` *on* the jump host
    instead presents the jump host's keys, not yours, and fails with
    `Permission denied (publickey)` even though the route and port are open.
    Confirm identity with `hostname` (expect `laundrytwin`) before assuming a
    bare TCP connect means you reached the VM.
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

1. Set `app_repo_ref` to the approved immutable commit or tag, and `app_image_tag` to the immutable image tag the release run published, then run `tofu apply` once. One tag covers the API and the SPA: they are not independently releasable, and `api_image_tag`/`web_image_tag` no longer exist.
2. Check `sudo docker compose -f /opt/analytics/compose.yaml ps` and confirm ClickHouse, Postgres, Airflow roles, Superset, Redis, and the app container are healthy.
3. Check `http://127.0.0.1:8787/health`, `http://127.0.0.1:8787/`, `http://127.0.0.1:8787/playground`, and `http://127.0.0.1:8088/health` on the VM. The SPA and the API are one port now. `/playground` is a client-side route with no file extension, so a 200 there proves the static half is really being served and not just that the process is up. `http://127.0.0.1:8787/api/anything` must be **404**, not the SPA shell — a 200-with-HTML there would reach the browser with no error code to map.
4. **Check the content type, not only the status code.** A status-only smoke passed while the merged container served the entire SPA as `text/plain`, because `c.body()` does not infer a MIME type — every code was correct and a browser displayed the page as source text. So:

   ```bash
   curl -sI http://127.0.0.1:8787/ | grep -i '^content-type'   # want text/html
   asset=$(curl -s http://127.0.0.1:8787/ | grep -o '/assets/[^"]*\.js' | head -1)
   curl -sI "http://127.0.0.1:8787$asset" | grep -i '^content-type'   # want text/javascript
   ```

   Both are served by `apps/api/src/spa.ts`, which refuses to answer a request
   under a server prefix, a non-GET, or a path escaping the web root.
5. Verify an unauthenticated report request is denied, an approved session is branch-scoped, invalid calendar dates return `400`, and logout revokes the session.
6. Verify the ClickHouse reader can query the analytics database and cannot use the admin credential from the API or browser.
7. Verify public TLS routes only after internal smoke passes. The Pi's Caddyfile must point `laundrytwin.duckdns.org` at **:8787**; the old `:8080` upstream no longer exists and the route will 502 until it is changed. Keep the MCP inspector local-only and keep `MCP_ALLOW_REVENUE=false` unless separately approved.

### Rollback

1. Stop further rollout steps and preserve logs, container status, and the failed application ref.
2. If the application ref is the cause, re-run `tofu apply` with `app_repo_ref=<last-known-good-ref>`. Do not delete volumes or run `docker compose down -v`.
3. If a schema or data migration is involved, restore the recorded app SQLite, ETL watermark, and analytics backups only after confirming the target backup and migration compatibility.
4. Re-run the internal health, auth, branch-scope, ClickHouse-reader, Airflow, and Superset smoke checks. Record the result in the change ticket before closing the incident.

This gate documents how a production change is made; it does not authorize
one. Any production deployment, production migration, live telemetry ingestion,
machine command, or payment write requires a separate explicit user request,
the recorded rollback ref, and the post-change smoke checks above.

## Access request — approved 2026-10-01 (`ด.ช.นน`, owner)

A LIFF access request had been pending since 2026-10-01 15:08 UTC for
`U284d77fa27c1bf0be58fe91ad71618d3` (display name `ด.ช.นน`). Until it was
approved, the browser showed the "ส่งคำขอเข้าใช้งานแล้ว" card instead of the
dashboard.

**It could not be approved through the admin UI.** The only two `owner` grants
in the app database belong to `Demo Owner` accounts, and the VM runs
`LAUNDRYTWIN_DEMO_MODE=false`, so `POST /api/demo/session` returns 404 and no
one can sign in to reach `/admin`. This is a bootstrap-ordering trap worth
knowing about: until a real owner exists, the access-request queue can only be
drained out of band.

Approved with `apps/api/scripts/approve-liff-access.mjs`, run inside the API
container. The script replicates `approveLiffAccessRequest` from
`apps/api/src/access-store.ts` because the container ships only
`dist/index.mjs`, where that function is bundled but not exported.

```bash
scp apps/api/scripts/approve-liff-access.mjs uunw@10.10.0.117:/tmp/
ssh -J notnotik-pve uunw@10.10.0.117
# Resolve the container by service, not by a hardcoded name. The service is
# `app` (it was `api` before the 2026-10-01 merge, and the container is
# `laundrytwin-app-1`) — Compose derives that suffix from the project and
# service names, so a hardcoded name breaks the moment either changes, and it
# breaks as "no such container" rather than as anything recognisable.
app_container=$(sudo docker compose -f /opt/laundrytwin/compose.yaml ps -q app)
# `compose ps -q` exits 0 with EMPTY output when the service is not running, so
# the substitution alone would hand `docker cp` an empty destination and fail
# with a message about the argument, not about the missing container. Check it.
test -n "$app_container" || { echo "app container not found — is it running?"; exit 1; }
sudo docker cp /tmp/approve-liff-access.mjs "${app_container}:/app/approve-liff-access.mjs"
sudo docker exec -u 0 "${app_container}" node /app/approve-liff-access.mjs \
  <requestId> owner - <actorUserId>
```

Set `app_container` once per shell session and reuse it for follow-up commands.
The empty check is not defensive noise: `docker compose ps -q` exits **0** for a
stopped service, so without it a stopped or renamed service surfaces as a
confusing `docker cp` argument error rather than as "the app is not running".

`owner` takes `-` for the branch because it is tenant-wide; `manager` and
`technician` each take exactly one `branchId`. The actor must hold a live
`owner` grant — here it was the `Demo Owner` account
`67d0791d-58aa-4998-858a-ddad75d876e3`, because no human owner existed yet. That
actor is recorded in `audit_log.action = 'access_request.approved'`, so the
trail shows a demo account approving the first real owner. That is what
happened, and it is worth knowing when auditing.

Result: created user `891fca30-a7f2-4f28-9bc6-1dc0fb69e12c`, a tenant-wide
`owner` grant `441da252-b7ec-4a5b-bb12-938dab62dfd2`, the `liff_identity` row,
and the audit entry — all read back and confirmed. App SQLite backed up first to
`/opt/backups/pre-approve-20260930T175021Z/laundrytwin.sqlite` (192 KB,
`integrity_check=ok`, row-counted against the source).

**The approved account has still not been seen completing a LINE sign-in.** The
grant removes the pending card by construction — the exchange finds a user with
a grant instead of returning 403 `ACCESS_PENDING` — but the LINE login flow
remains unverified end to end. To revoke, delete the grant via
`POST /api/admin/grants/:id/revoke` once a human owner can sign in, or mark it
revoked directly.

## Deploy record — 2026-10-01, web only (`33a84cd`)

Applied the LIFF-gate legal-route bypass to production. Web only; the API image
was not rebuilt, so no data or schema change was involved.

| Field | Value |
| :--- | :--- |
| Deployed ref | `33a84cd7883c5507bc5728b2da8287b33e4923b0` (`fix(web): keep the legal documents readable behind the LIFF gate`) |
| Image | `10.10.0.117:5000/laundrytwin-web:deploy-33a84cd-20261001`, digest `sha256:d4649eb1…` |
| Rollback ref | `10.10.0.117:5000/laundrytwin-web:latest` as it was **before** this deploy — image `sha256:b2ad47f1…`, repo digest `10.10.0.117:5000/laundrytwin-web@sha256:3025d9c6…`. Note that `:latest` has since been moved; the previous `latest` is also retained as `deploy-29c45c0-20260929`. |
| Scope | `docker compose up -d --no-deps web`. API, ETL, weather, gas, and the whole analytics stack were left running and were not recreated. Volume count before and after: 17. |
| App DB backup | `/opt/backups/pre-webdeploy-20261001T171800Z/laundrytwin.sqlite`, 192 KB, `integrity_check=ok`, 15 tables, 2 users, 2 access grants, read back and row-counted against the source. |

The build ran on the VM from a clean `git clone` at the exact commit, with
`--build-arg VITE_LIFF_ID=2011592166-uToRdTwS`. That build arg is the only
place the LIFF ID enters the web image — it is **not** in `/opt/laundrytwin/.env`
(only `*_IMAGE` variables are), so a web image built without it ships a bundle
where the gate is permanently a no-op and every route looks ungated.

**Back up the app SQLite with the online backup API, not `cp`.** The data is in
a `-wal` sidecar of about 1.4 MB; `cp` of the `.sqlite` file yields a 4 KB file
that looks plausible and is missing every uncommitted row. `better-sqlite3`'s
`db.backup(dest)` copies pages under a read lock and must be run from inside the
API container as root, writing to the `/data` mount (`/opt/laundrytwin/data`) —
`/opt/backups` is not mounted there — and the result is then moved into place on
the host. The path inside the container is `/data/laundrytwin.sqlite`, not
`/app/data/…`.

### Post-deploy smoke, as measured

Internal, on the VM: `/health` returned 200 on 8787, 8080, and 8088; the web
root returned 200; the served `index.html` referenced the new
`assets/index-BOs-dHS6.js`, and that bundle was confirmed to contain both the
bypass code and the LIFF ID. `/api/me`, `/api/report/dashboard`,
`/api/report/branches`, and `/api/twin` all returned 401 unauthenticated, and
`/api/auth/liff/exchange` still rejected a forged ID token with
`LIFF_VERIFICATION_FAILED`.

Public, over TLS in a real browser at `https://laundrytwin.duckdns.org`:
`/privacy` rendered the full 1382-character policy and `/terms` the full
1007-character terms document, with no pending card and no gate error;
`/dashboard` still redirected to `/login`, so the gate is intact on product
routes. A client-side `/privacy` → `/login` → `/terms` round trip was confirmed
to be a genuine router navigation and not a page reload (a `window` marker set
before the first hop survived), which is the behaviour the `useSyncExternalStore`
subscription exists to provide.

**What this does not establish.** The browser used here was not signed in to
LINE, so every visit took the `!liff.isLoggedIn()` early return. The specific
production case the fix targets — a user who *is* signed in and whose token
exchange returns 403 `ACCESS_PENDING` — was verified against a stubbed LIFF SDK
locally before the deploy, and the deploy confirms the correct bundle is being
served. It is not an end-to-end LINE verification, and the strict date
validation, branch scoping, and logout-revocation checks in the gate above were
not re-run because each needs an authenticated session with a branch grant.

### Rolling back

```bash
ssh -J notnotik-pve uunw@10.10.0.117
cd /opt/laundrytwin
sudo sed -i 's#^WEB_IMAGE=.*#WEB_IMAGE=10.10.0.117:5000/laundrytwin-web:deploy-29c45c0-20260929#' .env
sudo docker compose up -d --no-deps web
```

Prefer an explicit `deploy-<sha>-<date>` tag over `:latest` for the running
web service. `WEB_IMAGE` was previously left on `:latest`, which is why the
pre-deploy image had no immutable ref to record — a moving tag makes "what was
deployed before this" unanswerable at rollback time. The API is already pinned
(`deploy-39cc632-20260929`) and should stay that way.

## Deploy record — 2026-10-01, API from `main` (`d56220d` → `93b03cf` → `170b527`)

Deploying the API from `main` was explicitly requested. It carried 36 commits
that had never run in production. The review before deploying found no schema,
auth, or data-layer change — `git diff 39cc632..main -- apps/api/src/schema.ts
apps/api/src/db.ts` is empty — and 320 API tests green. The risk was not in the
review but in what the smoke test then found.

**The whole batch shared one root cause.** Production runs ClickHouse-only, but
four report routes still decided their source with `isDevelopmentAuthBypassEnabled()`
alone. Commit `8b2d7e8` had already fixed `/api/report/summary` by adding
`|| (!isDemoModeEnabled() && !isIrisReadConfigured())`; the same gap survived in
the routes around it. Each was found only by loading the real page:

| Route | Symptom in production | Fixed in |
| :--- | :--- | :--- |
| `/api/report/branches` | 503 — Digital Twin rendered no branches at all | `ec60130` |
| `/api/report/live` | 503 — a branch name with nothing under it | `93b03cf` |
| `/api/report/alerts` | 503 — Analytics page | `170b527` |
| `/api/report/events` | 503 — no caller in `apps/web`, so no visible symptom | see below |

The rule all four now share: answer from the warehouse whenever IRIS cannot
answer. Demo mode stays on the IRIS client, because `createIrisReadClient` serves
it with no IRIS env var set. Auth was never the issue — every one of these
returned 401 unauthenticated both before and after, and each fix kept the
existing `requireReportPrincipal` / `requireSingleBranch` scoping.

The alerts case is not the same kind of bug and is worth stating separately. The
warehouse has **no alert fact source**, and the honest "unavailable, and here is
why" answer was already written — it was simply unreachable behind the dev-bypass
gate. A 503 tells the operator the source is broken; the warehouse is fine, the
table does not exist. Absent and broken must not read the same.

`/api/report/events` had the same gate and **no ClickHouse branch at all**, so
fixing it meant writing a contract rather than exposing an existing one. It was
left alone through the first three deploys and fixed afterwards, deliberately
after measuring the live table rather than assuming its state.

The distinction that shaped the contract: `/api/report/alerts` has **no table
at all** in the warehouse, while `fact_machine_event` **exists and holds 0
rows** (measured on the VM 2026-10-01, `MergeTree`, `total_rows: 0`). Those
are three different states — absent, present-but-never-written, and
present-with-data — and the response says which one it is:

| Live state | `availability` | Carries a `reason` |
| :--- | :--- | :--- |
| rows in window | `available` | no |
| table present, 0 rows | `unavailable` | yes |
| no table | 503 via `irisError` | no |

An empty `events` array is **not** reported as "no events in this window".
Nothing has ever been ingested, so the honest answer is that the source cannot
tell you, not that the answer is zero. The test is named for this:
*"reports an unwritten table as unavailable, never as a window with no events."*

Coverage is carried per event rather than flattened, because
`fact_machine_event` stores no temperature, remaining time, door, coinbox, or
payment registers. Every one of those is `available: false` with a stated
reason instead of a bare `null` that reads like a zero.

Paging is a keyset cursor over `(occurred_at, event_id)` — the same pair as the
`ORDER BY`, so a walk cannot skip or repeat a row the way an offset would if
events arrived mid-pagination. `limit + 1` rows are fetched so `hasMore` needs
no second count query. The cursor is base64url-encoded because `event_id` is an
opaque source string; it is split on the **first** `|`, since `occurred_at` is a
ClickHouse `DateTime` and cannot contain one while `event_id` can. Splitting on
the last separator instead truncates an id that contains `|`, paging from a
boundary that never existed — caught by a round-trip test.

**Five of the seven new tests were verified to fail** against the pre-fix gate
before being accepted; all seven pass after.

#### The unit tests could not have caught the two real defects

The first deployment of this route **returned 500 on every call.** The gate fix
was correct and every test passed, because neither defect is visible from the
code — both are properties of the live warehouse, and both were found only by
running the exact SQL against production ClickHouse 26.3 on the VM:

| What | Error from production | Why no test could see it |
| :--- | :--- | :--- |
| `FINAL` on the event log | `Storage MergeTree doesn't support FINAL. (ILLEGAL_FINAL)` | `fact_machine_event` is plain `MergeTree`; the four sibling queries all join `ReplacingMergeTree` tables where `FINAL` is correct, so copying their shape looked right |
| `machine_id` join | `There is no supertype for types UUID, String … (NO_COMMON_TYPE)` | `machine_id` is `UUID` in `dim_machine` and `String` in `fact_machine_event` — a schema mismatch invisible until the join is executed |

Both are now pinned by tests **and** explained in the source, because both invite
a well-meaning future "cleanup" back to the broken form. The `FINAL` asymmetry
is deliberate: an append-only log has no duplicate rows to collapse, and
ClickHouse rejects the modifier outright. The join cast is on the **dimension**
side — `toString(m.machine_id)`, not `toUUID(e.machine_id)` — because
`toUUID()` would typecheck but throw on any event row whose `machine_id` is not
a parseable UUID, while `toString()` is total.

This is the argument for running new warehouse SQL against the real engine
before deploying, and it belongs next to the other live-verified records here.

#### What shipped

`deploy-0663e76-20261001`, from pinned commit `0663e76` (the two commits above).
Backup `backup-pre-events-20261001T032242Z.sqlite`, taken with the SQLite
**online backup API** — never `cp`, because the WAL sidecar was 1.75 MB against a
4 KB main file, so a copy would have captured almost nothing. Verified
`integrity_check: ok`, 196,608 bytes, 15 tables. Rollback target was
`deploy-170b527-20261001`; the intermediate `deploy-7e6d2dd` is retained and is
the correct rollback for the gate fix alone.

Smoke test over TLS at `https://laundrytwin.duckdns.org`: all five report routes
**401 unauthenticated**, all pages 200. The authenticated response was verified
by driving the deployed bundle in-process against the live warehouse:

```json
{ "contractVersion": "clickhouse-events", "source": "clickhouse",
  "availability": "unavailable",
  "reason": "fact_machine_event is present but empty; no machine events have been ingested",
  "events": [], "nextCursor": null }
```

That is the whole point of the contract: a 200 that says the source cannot
answer, with the reason attached — not a 503 implying breakage, and not an empty
array implying a quiet week. Branch-scoped calls behave the same, and a
malformed range is still rejected with `INVALID_RANGE`. **Browser E2E is still
pending** — the LINE LIFF session had expired and `liff/exchange` cannot complete
outside the LINE app, which is the known-unverified auth flow.

Suite after the fix: **534 green** (API 346, web 101, ETL 87).

### Verified in a real browser, not just by status code

Over TLS at `https://laundrytwin.duckdns.org` as a signed-in LINE user:

- **Digital Twin** — `/machines` rendered all four machines with branch
  `e9b98f78` and honest states: no machine claimed healthy while showing no
  usage evidence.
- **Dashboard** — `/api/report/dashboard` and `/api/report/summary` both 200 with
  real figures (846 cycles, ฿42,960, 23 machines, 2 branches) and the unattributed
  share stated in Thai: 670 of 846 cycles (79%) have no `machine_session_id`.
- **Analytics** — the two endpoints that 404'd (`off-peak`, `weather/usage`) now
  200, alongside the four that already did.

Test counts moved 320 → 330 API and 92 → 96 web. Every new test was checked to
fail against the old gate before being accepted, since a test that passes either
way proves nothing. `/api/report/live` had **no test of any kind** before this.

### The Thai-first defect the audit also found

Every Digital Twin card showed "No recent usage evidence is available for this
machine" — the server's freshness `reason` rendered verbatim on a Thai-first
page, directly under a Thai status pill. `freshnessMeta` moved into
`apps/web/src/lib/machine-status.ts` beside `machineStatusMeta`, which already
solves this exact problem for the status vocabulary, and each known freshness
state got a Thai reason. An unrecognized freshness stays unknown and falls back
to the server's own reason rather than guessing a cause.

The alerts card had the same defect for the same reason and was only visible
once `170b527` made it render at all: it showed "ClickHouse analytics warehouse
has no alert fact source" under a Thai heading. Fixed in `d573e9c` (web only) as
`apps/web/src/lib/alerts-view.ts`, following the existing `lib/*-view.ts`
convention. It keys on `contractVersion`, **not** on matching the English text —
matching prose would break silently the first time that string is reworded, and
would make a translation mistake look like a working check. An unrecognised
contract defers to the server's own reason, because this build cannot claim to
know why a response shape it does not model is unavailable.

**One deploy uncovered two of these.** Making a route answer is what makes its
English `reason` visible; fixing the source without fixing the presentation would
have shipped a Thai page with a newly-revealed English line. Check the card, not
just the status code.

### Final production state

Superseded by `deploy-84718f6-20261001` below; kept for the rollback targets it
names.

| Service | Image |
| :--- | :--- |
| api | `deploy-170b527-20261001` |
| web | `deploy-d573e9c-20261001` |

All six pages return 200 (`/dashboard`, `/machines`, `/analytics`, `/admin`,
`/playground`, `/ai`). All eight API routes still return 401 unauthenticated,
so none of the fallbacks widened access. In the browser, every Analytics request
is now 200 including alerts, and the rendered card reads "คลังข้อมูล ClickHouse
ยังไม่มีแหล่งข้อมูลการแจ้งเตือน" with no English reason anywhere in the page
body (checked programmatically, not by eye).

**Still not established by any of this:** these are real responses from the
production ClickHouse warehouse over TLS, but the branch and machine scope was
exercised as a single tenant-wide owner. The per-branch scoping paths are covered
by unit tests, not by a production account holding a narrower grant, and LINE
end-to-end verification is still outstanding.

### Rolling back

`170b527` deploys API and web together (both files changed). Roll back to the
previous API, which is the last commit with only the API-side fixes:

```bash
ssh -J notnotik-pve uunw@10.10.0.117
cd /opt/laundrytwin
sudo sed -i 's#^API_IMAGE=.*#API_IMAGE=10.10.0.117:5000/laundrytwin-api:deploy-93b03cf-20261001#' .env
sudo sed -i 's#^WEB_IMAGE=.*#WEB_IMAGE=10.10.0.117:5000/laundrytwin-web:deploy-33a84cd-20261001#' .env
sudo docker compose up -d --no-deps api web
```

### `deploy-84718f6-20261001` — a stale LINE session is now recoverable

The LIFF login failure was not a server outage and never was. A user whose LINE
ID token had expired hit an unrecoverable dead end: the error said the exchange
failed and offered "ลองใหม่" (try again), and retrying re-ran the identical
exchange against the same dead token, forever.

The cause is a specific asymmetry in the LIFF SDK. `liff.isLoggedIn()` stays
**true** for an expired token and `liff.getIDToken()` hands the same expired one
back — the SDK does not surface expiry at all. The ID token lives 60 minutes,
while the access token lived `expires_in: 6893` at the time of the incident, so
the session looked healthy from the browser's side while LINE's
`/oauth2/v2.1/verify` endpoint rejected the ID token outright.

Three changes, each aimed at a different half of the problem:

| Layer | Change | File |
| :--- | :--- | :--- |
| Server | A token LINE rejected answers **401**, not 502 | `apps/api/src/liff-auth.ts`, `apps/api/src/index.ts` |
| Client | The `exp` claim is read **before** the exchange and a stale token short-circuits to a re-login | `apps/web/src/liff.ts`, `apps/web/src/lib/components/liff-gate.tsx` |
| Client | The sign-in button logs out a stale session instead of replaying it | `apps/web/src/routes/login.tsx` |

**Why the status code mattered.** LINE answers an expired, wrong-channel, and
malformed ID token with the same **400**. Forwarding that — or, as the route's
fallback did, collapsing everything into **502** — tells the operator the server
or a gateway is broken, which is not true and sends the debugging in the wrong
direction. Only two conditions are genuinely the server's fault and they stay
distinct: LINE unreachable (**502**) and no channel id configured (**503**).
Everything the caller can fix is **401**.

**Why the client checks `exp` at all.** With the server returning an opaque 401,
the browser still cannot tell a stale token from a misconfigured channel — so it
would still offer a retry that cannot work. Decoding `exp` client-side is what
lets the UI say "your session expired" and offer the one action that fixes it,
`liff.logout()` followed by a fresh sign-in. The payload is decoded but **not
verified**: it decides only what the user is told and whether to re-login.
Trusting a client-side `exp` for anything but presentation would be exactly the
"fabricate data" failure the project rules forbid, and signature verification
remains the server's job.

Note that `liff.logout()` returns **void** and navigates. Both call sites were
originally written as `await liff.logout().catch(...)` and the type checker
rejected them — the tests did not, because neither has a test.

> **Correction, `155e111` (2026-10-01).** The paragraph above is wrong, and it
> shipped a regression within the hour. The LIFF reference documents
> `liff.logout()` as clearing the session and returning nothing, with **no
> navigation side effect** — "returns void" was read as "and navigates", which
> the documentation does not say.
>
> The worse half: the login button called `logout()` for **any** logged-in
> session and then returned without exchanging, so a user holding a perfectly
> valid token was logged out and sent nowhere. The button could not sign anyone
> in. Only an **expired** token needs a logout, and a stale token still reports
> `isLoggedIn()` true — so the fix could not even reach the case it was written
> for.
>
> Both call sites carried their own copy of this logic and `login.tsx` had **no
> test of any kind**. Sign-in is now one path, `signInWithLiff`, behind the pure
> decision `planLineSignIn` (`login` / `exchange` / `renew`), so the choice is
> testable without a LINE client. Nothing assumes a navigation the SDK does not
> document, and `renew` clears the one-shot login guard before firing
> `liff.login()` so a guard left by the previous press cannot swallow it. An
> unreadable or absent token still resolves to `exchange`, never `renew`:
> unknown stays unknown, and discarding a session over a failed cache read would
> sign out users whose token was fine.
>
> The lesson worth keeping: **a UI path that can only be exercised inside the
> LINE client must have its decision logic extracted as a pure function**, or it
> ships untested. This one shipped green and dead.

#### What shipped

`deploy-84718f6-20261001`, from pinned commit `84718f6`. API and web deployed as
separate swaps because they are separate images. SQLite backup
`backup-pre-84718f6-20261001.sqlite` was taken with the online backup API before
the API swap (196,608 bytes, `integrity_check: ok`). Rollback targets were
`deploy-0663e76-20261001` (API) and `deploy-d573e9c-20261001` (web).

Verified in production **with the actual incident token**:

```
POST /api/auth/liff/exchange  {"error":{"code":"LIFF_VERIFICATION_FAILED",
                                         "message":"LINE identity token is invalid"}}
HTTP 401        (was 502)
```

Post-swap smoke test over TLS: all six real report routes (`branches`,
`dashboard`, `live`, `alerts`, `events`, `summary`) **401 unauthenticated**,
`/api/me` 401, bad origin **403**, missing token body **400** — auth and request
validation unchanged. `/`, `/login`, `/privacy`, `/terms`, `/dashboard` all
**200**, and the entry bundle served through nginx
(`index-D1z7nO9D.js`) contains both the Thai stale-session string and the
"เข้าสู่ระบบด้วย LINE อีกครั้ง" re-login button, so the client half is confirmed
live rather than merely built. Both containers at `restarts=0`.

`VITE_LIFF_ID` is a Docker **build-arg**, not an `.env` value — the runbook
already records that the build arg is the only place the LIFF id enters the web
image, so the build had to pass it explicitly and it was confirmed baked into
the bundle rather than assumed present.

**Still not verified: live browser end-to-end recovery.** Confirming that the
stale user is actually recovered requires signing in with a real LINE account,
which was deliberately not performed. What is verified is that the failure now
reports the truth, that the page carries the recovery action, and that the
button's `logout()` path typechecks against the SDK's real signature.

Suite after the change: **547 green** (API 351, web 109, ETL 87).

#### Rolling back `84718f6`

```bash
ssh -J notnotik-pve uunw@10.10.0.117
cd /opt/laundrytwin
sudo sed -i 's#^API_IMAGE=.*#API_IMAGE=10.10.0.117:5000/laundrytwin-api:deploy-0663e76-20261001#' .env
sudo sed -i 's#^WEB_IMAGE=.*#WEB_IMAGE=10.10.0.117:5000/laundrytwin-web:deploy-d573e9c-20261001#' .env
sudo docker compose --env-file .env up -d --no-deps api web
```

Both earlier tags are retained in the registry. Rolling the API back to
`deploy-93b03cf-20261001` restores branches and live state; rolling back to
`deploy-39cc632-20260929` restores the pre-session state, in which the Digital
Twin is empty and Analytics shows two 404s.

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
| Public host 502s but `127.0.0.1:8787/health` is 200 on the VM | The Pi Caddyfile still proxies to the old `:8080`, which no longer exists since the api+web merge | `ssh` the Pi and check the `laundrytwin.duckdns.org` block proxies to **:8787**. This is the single most likely post-merge failure, and the health check on the VM will look perfect while the public route is down. |
| A page renders as **raw HTML source text** instead of the app | The SPA was served without a `Content-Type`, so the browser displayed it rather than rendering it. Correct bytes, correct 200 — no error anywhere | `curl -sI http://127.0.0.1:8787/ \| grep -i content-type` — must be `text/html`. A regression here means the static handler stopped setting the header; `c.body()` does not infer one, it defaults to `text/plain`. |
| A mistyped API path returns the app's HTML instead of 404 | The SPA fallback swallowed a server path | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/anything` — must be **404**. `/api`, `/webhooks`, `/mcp`, `/docs` and `/health` are never the SPA's; see `SERVER_PATH_PREFIXES` in `apps/api/src/spa.ts`. |

### `deploy-155e111-20261001` — the LINE sign-in button could not sign anyone in

Reported one hour after `84718f6` shipped: pressing **เข้าสู่ระบบด้วย LINE**
did nothing and never reached the dashboard. A regression in the fix itself, not
a new defect.

`onLineSignIn` called `liff.logout()` whenever `isLoggedIn()` was true and then
returned **without exchanging**. LIFF reports `isLoggedIn()` true for a healthy
session, so every already-signed-in user was logged out and sent nowhere — the
button was inert. Only an *expired* token needed a logout, and a stale token
reports `isLoggedIn()` true too, so the change could not reach the one case it
was written for: both paths took the same branch.

| | Before | After |
| :--- | :--- | :--- |
| No session | `liff.login()` | `login` |
| **Live token** | **`logout()`, return — dead** | `exchange` |
| Expired token | `logout()`, return | `renew` |
| Token unreadable | treated as expired | `exchange` (unknown ≠ expired) |

Rollback target `deploy-84718f6-20261001`. Web only — the API was untouched, so
no SQLite backup was taken and `laundrytwin-api-1` was never recreated (still
`deploy-84718f6`, `restarts=0`).

Post-deploy over TLS: `/`, `/login`, `/privacy`, `/terms`, `/health` all **200**;
entry bundle `index-sT6pqrPy.js` served, with the LIFF id and the Thai
stale-session string baked in. All six report routes still **401**
unauthenticated, so no fallback widened access.

**Verified end to end, 2026-10-01.** The owner signed in with LINE in the real
client against production and reached the dashboard. This is the `exchange`
plan — a live token traded for a session cookie — which is the ordinary path and
precisely the one the regression had made unreachable, so it is the case worth
having confirmed live rather than only in a unit test.

Two things remain test-only, and should not be read as covered by that check:

- **`renew`** — an expired token forcing `logout()` and a fresh login. Unit
  tested against the exact regression, not reproduced live; doing so would mean
  waiting out a real token expiry.
- **`/api/me` and the redirect chain** after the exchange, which the successful
  sign-in implies but which was not separately asserted.

What the live check adds beyond the suite: `liff.init`, the openid scope and the
user's consent all work in the real client, and the LIFF id baked into the image
is the right one for this channel.

Suite: **552 green** (API 351, web 114, ETL 87); `pnpm check` and `pnpm build`
clean; Playwright layout 20 passed.

#### Rolling back `155e111`

```bash
ssh -J notnotik-pve uunw@10.10.0.117
cd /opt/laundrytwin
sudo sed -i 's#^WEB_IMAGE=.*#WEB_IMAGE=10.10.0.117:5000/laundrytwin-web:deploy-84718f6-20261001#' .env
sudo docker compose --env-file .env up -d --no-deps web
```

## Deploy record — 2026-10-01, API + web (`cbe7243`)

Both halves of the UX-honesty work, deployed together from pinned commit
`cbe7243` (`939d7ae` + `cbe7243`). The API half changes the **machine-state
contract**; the web half consumes it. Deploying web alone would have shown a
field the running API never sent, so this had to be one apply.

| | |
| :--- | :--- |
| Images | `10.10.0.117:5000/laundrytwin-api:deploy-cbe7243-20261001`, digest `sha256:64735a16…`<br>`10.10.0.117:5000/laundrytwin-web:deploy-cbe7243-20261001`, digest `sha256:68682049…` |
| Rollback refs | api `deploy-84718f6-20261001`, web `deploy-155e111-20261001` |
| App DB backup | `/opt/backups/pre-cbe7243-20261001T062410Z/laundrytwin.sqlite`, 196,608 bytes, `integrity_check: ok`, 15 tables, 3 users, 3 access grants |
| Suite before deploy | **625 green** (API 359, web 179, ETL 87); `pnpm check` clean; `pnpm build` clean; Playwright **28** passed |
| Containers after | 19 running, `restarts=0` on both swapped services; etl/gas/weather untouched (`Up 17–38 hours`) |

Built on the VM from `git clone --no-checkout` + `git checkout cbe7243` into
`/tmp/lt-cbe7243`, per the gate's "immutable commit, not `main`". The web image
carries `--build-arg VITE_LIFF_ID=2011592166-uToRdTwS`, which is still the only
place the LIFF ID enters the image.

### The backup that first looked fine and was not

`cp /opt/laundrytwin/data/laundrytwin.sqlite` produced a **4,096-byte** file
and reported success. The main DB file *is* 4 KB — the database is in WAL mode
and its actual 2 MB live in `laundrytwin.sqlite-wal`. A file copy of a WAL-mode
database captures the schema stub and none of the rows, and it fails silently:
`ls -l` shows a plausible file and only the row counts give it away.

The real backup goes through the online backup API, which folds the WAL in:

```js
const db = new Database("/data/laundrytwin.sqlite", { readonly: true });
await db.backup("/data/pre-deploy.sqlite");
```

`db.backup()` is promise-based in the installed `better-sqlite3` — it exposes
only `then`/`catch`/`finally`, so the `backup.step(-1)` form from older docs
throws `backup.step is not a function`. The result is 196,608 bytes and verifies
with 15 tables, 3 users, and 3 access grants, matching the production counts.
**Any future backup taken by file copy should be treated as failed.**

### The changed SQL, run against live ClickHouse

`buildMachineStateSQL()` now selects the denominator separately:

```sql
countIf(u.status IN ('paid', 'finished')) AS cycle_count,
countIf(u.status IS NOT NULL) AS usage_rows
```

`countIf(... IS NOT NULL)` rather than `count()` because `join_use_nulls = 1`
suppresses the LEFT JOIN placeholder row; a plain `count()` would report 1 for a
machine with no usage at all, which is the exact confusion the field exists to
remove. Run verbatim against production ClickHouse 26.3.26 (read-only, via the
app's reader credentials):

| Machine | `cycle_count` | `usage_rows` |
| :--- | ---: | ---: |
| D5 | 193 | 202 |
| D7 | 181 | 190 |
| W1 | 144 | 153 |
| W2 | 147 | 153 |
| D3 | 124 | 124 |

All 19 active machines split cleanly. Grouping them by contract state over the
full history gives only `counted` (19 machines, 313–547 rows each) — because
every machine has paid history somewhere. **The state the fix exists for only
appears in a bounded window**, which is what the interface actually shows:

| Window | `no_rows` | `rows_but_none_paid` | `counted` |
| :--- | :--- | :--- | :--- |
| 2026-09-24 → 09-30 | 0 | 0 | 19 |
| 2026-09-16 → 09-22 | 0 | 0 | 19 |
| **2026-07-27** (known source gap) | **19** | 0 | 0 |

So the `no_rows` state is real and reachable in production, and it is exactly
the day the old code would have printed "ไม่มีข้อมูลแถว usage" as though the
machine had never run. `rows_but_none_paid` did not occur in any window tested;
it remains covered by unit tests only, and this measurement does not claim
otherwise.

### Smoke after the swap, against TLS

Every status matches the pre-swap baseline exactly, so no fallback widened and
no route regressed:

| Check | Before | After |
| :--- | :--- | :--- |
| `/api/report/{branches,dashboard,live,alerts,events,summary}` unauth | 401 ×6 | **401 ×6** |
| `/api/me` unauth | 401 | **401** |
| `/health` | 200 `{"ok":true,"reportingConfigured":false,"demoMode":false}` | **200, identical** |
| `POST /api/auth/liff/exchange` no token | 400 | **400** |
| same, bad `Origin` | 403 | **403** |
| same, invalid ID token | 401 `LIFF_VERIFICATION_FAILED` | **401, identical body** |
| `/`, `/login`, `/privacy`, `/terms` | 200 | **200** |
| entry bundle | `index-sT6pqrPy.js` | `index-CDOn3Rpg.js` |

The new bundle carries the LIFF id, `ไม่มียอดก่อนหน้าให้เทียบ`, and
`แหล่งข้อมูลรายงานไม่ตอบสนอง`; the API bundle carries `usage_rows`,
`cycleCountSource`, `usage_row`, `usageFreshnessOf`, and the literal
`countIf(u.status IS NOT NULL) AS usage_rows`. **Authenticated report rendering
is still not verified in a browser** — every report route is 401 without a
session, and this deploy did not add one. What is verified is the contract, the
SQL against the real engine, and that the auth boundary did not move.

#### Rolling back `cbe7243`

```bash
ssh -J notnotik-pve uunw@10.10.0.117
cd /opt/laundrytwin
sudo sed -i 's#^API_IMAGE=.*#API_IMAGE=10.10.0.117:5000/laundrytwin-api:deploy-84718f6-20261001#' .env
sudo sed -i 's#^WEB_IMAGE=.*#WEB_IMAGE=10.10.0.117:5000/laundrytwin-web:deploy-155e111-20261001#' .env
sudo docker compose --env-file .env up -d --no-deps api web
```

Rolling back both is required, not optional: the web at `cbe7243` reads
`cycleCountSource` and `freshness`, which the API at `84718f6` does not send.
The pre-swap `.env` is also kept at `/opt/laundrytwin/.env.pre-cbe7243`. No
schema migration shipped, so the SQLite backup above is insurance rather than a
restored artifact.

## Deploy record — 2026-10-01, API + web (`0ffb7ff`)

The Digital Twin honesty follow-ups, deployed together from pinned commit
`0ffb7ff` (which contains `3e43882`). Both services ship in one apply because the
web half keys Thai error copy on codes only the new API emits, and the twin-card
change is web-only but rides the same swap.

| | |
| :--- | :--- |
| Images | `10.10.0.117:5000/laundrytwin-api:deploy-0ffb7ff-20261001`, repo digest `sha256:f4b8e5db…`, image `sha256:dc793c6e…`<br>`10.10.0.117:5000/laundrytwin-web:deploy-0ffb7ff-20261001`, repo digest `sha256:eb695773…`, image `sha256:00274571…` |
| Rollback refs | api `deploy-84718f6-20261001`, web `deploy-155e111-20261001` |
| App DB backup | `/opt/backups/pre-0ffb7ff-20261001T084141Z/laundrytwin.sqlite`, 196,608 bytes, `integrity_check: ok`, 15 tables, 3 users, 3 access grants — **identical to live** |
| Suite before deploy | **629 green** (API 360, web 182, ETL 87); `pnpm check` clean; `pnpm build` clean; Playwright **32** passed |
| Containers after | api + web healthy, `restarts=0`; etl/gas/weather untouched (`Up 19–41 hours`); volume count 17 before and after |

Built on the VM from a throwaway `/tmp/lt-0ffb7ff` clone, per the gate's
"immutable commit, not `main`". The web image carries
`--build-arg VITE_LIFF_ID=2011592166-uToRdTwS`; the LIFF id is still present in
the shipped entry bundle (`index-BsdEn03p.js`), confirmed by grep after the swap.

### The WAL trap, encountered again on the way in

The pre-deploy backup step printed the trap before it could bite:

```
4096     /opt/laundrytwin/data/laundrytwin.sqlite
2097112  /opt/laundrytwin/data/laundrytwin.sqlite-wal
```

The main file is a 4 KB schema stub; ~2 MB of live data sits in the `-wal`
sidecar. A `cp` of the main file would have "succeeded", produced a plausible
artifact, and captured **no rows**. The backup went through
`db.backup("/data/pre-deploy.sqlite")` inside the API container, which folds
the WAL in, and the result was moved out to the backup directory.

Two corrections to the earlier record's method, both learned here:

- `db.backup()` cannot write to a host path — the destination must exist **inside
  the container's mount**, or it fails with `Cannot save backup because the
  directory does not exist`. Write to `/data`, then move the file out.
- Verify the backup with `better-sqlite3` opened `readonly` on a copy placed
  inside `/data`, not by running `keinos/sqlite3`. That image treats a bare
  `.sqlite` argument as an entrypoint and dies with `Exec format error`, which
  looks like a corrupt backup but is not one.

Table names are snake_case (`access_grant`, not `accessGrant`); guessing them
wrong fails with `no such table`.

### Smoke after the swap

Every status matches the pre-swap baseline exactly, so no fallback widened and
no route regressed. The baseline was taken on `http://localhost:8080` — nginx
terminates plain HTTP there and proxies `/api/*` to `api:8787`; probing `https`
on that port returns `000`, which reads like an outage and is not one.

| Check | Before | After |
| :--- | :--- | :--- |
| `/api/report/{branches,dashboard,live,alerts,events,summary}` unauth | 401 ×6 | **401 ×6** |
| `/api/me` unauth | 401 | **401** |
| `/health` | 200 `{"ok":true,"reportingConfigured":false,"demoMode":false}` | **200, identical** |
| `POST /api/auth/liff/exchange` no token | 400 | **400** |
| same, bad `Origin` | 403 | **403** |
| same, invalid ID token | 401 `LIFF_VERIFICATION_FAILED` | **401, identical body** |
| `/`, `/login`, `/privacy`, `/terms` | 200 | **200** |
| entry bundle | `index-CDOn3Rpg.js` | `index-BsdEn03p.js` |

### The shipped bundles, checked for the changes themselves

A green status list proves nothing regressed; it does not prove the fix is
present. Counted greps against the running containers:

| Assertion | Expected | Measured |
| :--- | :--- | :--- |
| `new Error("INVALID_CURSOR")` in API bundle | 0 | **0** |
| `InvalidCursorError` in API bundle | ≥1 | **4** |
| `machine-drum` / `machine-floor-visual` in web bundle | 0 | **0** |
| `machine-floor-card` in web bundle (cards survive) | ≥1 | **4** |
| `"Usage data is older than 30 minutes"` occurrences | 1 | **1** |
| new Thai copy (`หน้ารายการถัดไปไม่ถูกต้อง`, `บทบาทของคุณไม่มีสิทธิ์ดูข้อมูลรายได้`, `ยังเชื่อมต่อคลังข้อมูลวิเคราะห์ไม่ได้`) | present | **all 3 in `index-BsdEn03p.js`** |

The last row is the interesting one: the freshness reason string now appears
**once** in the whole API bundle. It appeared twice before this deploy, because
`demoFreshnessFields` restated what `usageFreshnessReasonOf` owns. That is the
duplication removed, measured in the artifact rather than argued from the diff.

**Still not verified:** authenticated report rendering in a browser. Every
report route is 401 without a session and this deploy added none, so the Thai
error copy is verified as *shipped bytes*, not as *rendered output*. The
`INVALID_CURSOR` 400 likewise has no live request behind it — `fact_machine_event`
holds 0 rows, so a malformed cursor is rejected before any query runs and there
is no production path that reaches it yet.

#### Rolling back `0ffb7ff`

```bash
ssh -J <jump> uunw@10.10.0.117
cd /opt/laundrytwin
sudo sed -i 's#^API_IMAGE=.*#API_IMAGE=10.10.0.117:5000/laundrytwin-api:deploy-84718f6-20261001#' .env
sudo sed -i 's#^WEB_IMAGE=.*#WEB_IMAGE=10.10.0.117:5000/laundrytwin-web:deploy-155e111-20261001#' .env
sudo docker compose --env-file .env up -d --no-deps api web
```

The pre-swap `.env` is kept at `/opt/laundrytwin/.env.pre-0ffb7ff`. Rolling back
to `84718f6`/`155e111` is safe here even though the web at `0ffb7ff` reads
`cycleCountSource` and `freshness` — that contract was already deployed by
`cbe7243`, which is newer than both rollback targets. No schema migration
shipped, so the SQLite backup is insurance rather than a restored artifact.

## Deploy record — 2026-10-01, web only (`84da0f1`)

The LIFF-gate session-probe fix. Web only; the API image was not rebuilt, so no
data, schema, or migration change was involved. This deploy **restored
production for every authenticated user** — the gate was blocking all of them.

| Field | Value |
| :--- | :--- |
| Deployed ref | `84da0f15ee8597c77a864fea196fb1b383639f90` (`fix(web): stop a stale LINE token from locking out a signed-in browser`) |
| Images | `10.10.0.117:5000/laundrytwin-web:deploy-84da0f1-20261001`, repo digest `sha256:d088e488…`, image `sha256:8b8b86d3…` |
| Rollback ref | `10.10.0.117:5000/laundrytwin-web:deploy-0ffb7ff-20261001`, repo digest `sha256:eb695773…`, image `sha256:00274571…` |
| Scope | `docker compose up -d --no-deps web`; `WEB_IMAGE` repointed in `/opt/laundrytwin/.env`, previous file kept at `.env.pre-84da0f1`. API, ETL, gas, and weather kept their uptimes (44 min / 20 h / 20 h / 41 h). Volume count 17 before and after. |
| App DB backup | `/opt/backups/pre-84da0f1-20261001T092818Z/laundrytwin.sqlite`, 196,608 bytes, `integrity_check: ok`, 15 tables, 3 users, 3 access grants |
| Suite before deploy | **636 green** (API 360, web 189, ETL 87); `pnpm check` and `pnpm build` clean; Playwright **36** (32 + 4 new, each verified to fail against the old code) |

Built on the VM from a throwaway `/tmp/lt-84da0f1` clone at the exact commit
(`git rev-parse HEAD` == `origin/main` == `84da0f15ee8…`), with
`--build-arg VITE_LIFF_ID=2011592166-uToRdTwS`.

**The build context is the repo root, not `apps/web`.** `apps/web/Dockerfile`
copies `deploy/nginx.conf` in its runtime stage, so
`docker build -f apps/web/Dockerfile … apps/web` fails with
`failed to calculate checksum … "/deploy/nginx.conf": not found`. The path in
`-f` and the context argument are different things; the Dockerfile's own header
comment says "Build from the repo root".

### Bundle checks before the swap

A green status list does not prove the fix shipped, so the built image was
grepped for the fix's own strings first:

| Marker | Found in |
| :--- | :--- |
| LIFF id `2011592166-uToRdTwS` | `index-E6iFYXm0.js`, `login-C6R0-UK9.js` |
| `เข้าสู่ระบบด้วยอีเมลแทน` (the escape link) | `index-E6iFYXm0.js` |
| `ไม่สามารถเชื่อมต่อกับ LINE ได้` (the Thai failure copy) | `index-E6iFYXm0.js` |
| `/api/me` (the session probe) | 4 occurrences in `index-E6iFYXm0.js` |

`Failed to fetch` still appears **once** in the bundle. Its context is Vite's
internal dynamic-import handler
(`startsWith("Failed to fetch dynamically imported module")`), not the gate's
card copy — the card renders the Thai string instead. Do not read that grep hit
as a leak.

### Smoke after the swap

Every status matches the pre-swap baseline exactly, so no fallback widened and no
route regressed.

| Check | Before | After |
| :--- | :--- | :--- |
| `/api/report/{branches,dashboard,live,alerts,events,summary}` unauth | 401 ×6 | **401 ×6** |
| `/api/me` unauth | 401 | **401** |
| `POST /api/auth/liff/exchange` no token | 400 | **400** |
| `/health` | 200 `{"ok":true,"reportingConfigured":false,"demoMode":false}` | **200, identical** |
| `/`, `/login`, `/privacy`, `/terms` | 200 | **200** |
| entry bundle | `index-BsdEn03p.js` | **`index-E6iFYXm0.js`** |
| web container restarts | — | **0** |

The same four markers were re-grepped in the **running** container after the
swap and all were present, so the deployed bundle is the one that was checked.

### The production symptom is now closed, in the browser that had it

This is the first deploy in this runbook with a **browser-level before/after on
the actual defect**, rather than a status list. The same Chrome profile that
produced the bug — the one holding `ด.ช.นน`'s session — was re-checked after the
swap:

- `/login` renders the real page: the LINE button, the email form, and both
  legal links. Before the deploy it rendered **nothing but the stale card**,
  because the card replaced the whole page.
- `/dashboard` renders the full dashboard — topbar, sign-out, branch filter,
  KPIs, and both branch cards. `/api/me` answers **200** with the tenant-wide
  `owner` grant `441da252-…`, and `.liff-message-card` is absent.

That closes the limit recorded with the fix: the exact cause — an expired
cached ID token in a browser that already holds a working session — could not be
reproduced synthetically, because the LIFF SDK discards a seeded localStorage
store and a real provider token must never be handled. It was reproduced anyway
by the user who actually had it, in the browser that actually had it.

**What is still unverified.** The `renew` plan (an expired token forcing
`logout()` and a fresh login) remains covered by unit tests only. The LIFF store
is encrypted by the SDK, so the cached token's `exp` could not be read back to
prove it was still expired at the moment of the check — the session cookie was
used as the evidence instead, which is what the gate itself now trusts. And the
sign-in flow itself has still not been observed completing fresh in the LINE
client.

## `deploy-97c45ac-20261001` — api + web merged into one image and container

**Status: deployed.** Commit `97c45ac`, image `laundrytwin:deploy-97c45ac-20261001`
(208 MB, built `linux/amd64` from `apps/api/Dockerfile` with `VITE_LIFF_ID`
baked at build time). Replaces `api:deploy-0ffb7ff-20261001` and
`web:deploy-84da0f1-20261001`, both of which are retained as the rollback
target and are still pinned in `.env`.

This is the deploy that makes the api+web merge structural rather than
documentary: **one image, one container, one port (`:8787`)**, serving both the
JSON API and the built SPA from one process.

### What had to happen outside the compose file

`compose.yaml` was swapped for `compose.merged.yaml` and `docker compose up -d
--remove-orphans app` removed `laundrytwin-api-1` as an orphan and created
`laundrytwin-app-1`. The container resolves by **service** (`app`), not by a
hardcoded name, per the correction recorded above.

The Caddyfile on the Pi is a **second, separate** deployment and the compose
swap alone is not sufficient. Two lines in `/home/dietpi/stack/caddy/Caddyfile`
pointed `reverse_proxy` at `10.10.0.117:8080` — the old `web` container's port,
which ceases to exist with the merge, so the public route **502s until they are
repointed at `:8787`**:

```text
327:  laundrytwin.duckdns.org    → :8080 → :8787
446:  web.laundrytwin.duckdns.org → :8080 → :8787
```

Two other `8080` references exist in that file and were **deliberately not
touched** — they belong to other services (`media.pve.local:8080` at line 117 and
`10.10.0.5:8080` at line 223). A blunt find-and-replace would have broken them,
so the edit was anchored on the full upstream string `10.10.0.117:8080`, which
occurs in exactly those two lines. `diff` against the backup confirms two lines
changed and nothing else.

**Caddy could not be reloaded, and the reason is a deliberate setting.** The
global options block sets `admin off`, so Caddy's admin API on `:2019` refuses
connections and `caddy reload` cannot work — it fails with
`Post "http://localhost:2019/load": connection refused`. The container must be
**recreated** for any Caddyfile change on this host, which briefly blips every
hostname this Caddy serves, not only LaundryTwin's. The ~10 `Caddyfile.pre-*`
files in that directory are the record of that having been the procedure all
along. `caddy validate` must pass **before** the recreate; note it also hangs if
stdin is left attached, so it needs `</dev/null`.

Captured before the recreate, since a faithful rebuild depends on them:
image `caddy:2-alpine`, `--network proxy`, `-p 80:80 -p 443:443`,
`--restart unless-stopped`, three bind mounts (`stack_caddy_config/_data`,
`stack_caddy_data/_data`, and the Caddyfile itself read-only), no caps, not
privileged.

### Smoke after the swap

Every status matches the pre-deploy baseline exactly, across all three public
hostnames.

| Check | Before | After |
| :--- | :--- | :--- |
| `/health` | 200 `{"ok":true,"reportingConfigured":false,"demoMode":false}` | **200, byte-identical** |
| `/api/report/{branches,dashboard,live,alerts,events,summary}` unauth | 401 ×6 | **401 ×6** |
| `/api/me` unauth | 401 | **401** |
| `POST /api/auth/liff/exchange` no token | 400 | **400** |
| `POST /api/admin/grants` (new route) unauth | — | **401** |
| `POST` to an unknown `/api/*` path | 404 `text/plain` | **404 `text/plain`** |
| `/api/__smoke__` | 404 | **404** |
| `/`, `/login`, `/privacy`, `/terms` | 200 | **200** |
| entry bundle | `index-E6iFYXm0.js` | **`index-10WERJ5R.js`** |

**The static half was checked, not assumed.** A `/health`-only smoke passes with
the entire SPA missing, which is the specific failure this merge could
introduce, so the content types are part of the result: `/` and `/playground`
serve `text/html; charset=utf-8`, the entry bundle `text/javascript`, the
stylesheet `text/css`, and `/fonts/noto-sans-thai-subset.woff2` `font/woff2` —
the `text/plain` default that renders HTML as source text, which was a live
defect caught by the first smoke of the merged container, did not recur.

`/api/real` answers **404** and is correct: that path exists only in
`spa.test.ts`'s fixture app, not in the real server. `/api/ai/settings` and
`/api/ai/models` answer **403**, not 401, because `requireOwner` runs in
middleware before any authentication check (`ai-routes.ts:45-51`). Both are
pre-existing and unrelated to this merge — recorded here so a future reader does
not read them as new.

ClickHouse was reached **from inside the app container** rather than assumed from
the host: engine `26.3.26.3`, **8,086** rows in `fact_machine_usage`. The
container has `CLICKHOUSE_*` set and rendering correctly, so `reportingConfigured:
false` on `/health` is the expected baseline — that flag reports
`IRIS_READ_BASE_URL`, the optional read-only IRIS integration production does not
configure, and the body is byte-identical to every prior deploy.

### In a real browser, against the public route

Chromium at 390px and 1440px, over TLS, no fixtures:

- `/login` renders the real page — LINE button, email and password inputs, both
  legal links, and **no** `.liff-message-card` (which would mean the LIFF gate
  had replaced it again).
- Hard navigation to the deep link `/privacy` boots the app: `lang="th"`,
  `#root` populated, stylesheet applied, `document.fonts.check` true for the
  vendored Noto Sans Thai.
- No horizontal overflow at 390px (`scrollWidth - clientWidth === 0`).
- **Zero page errors and zero console errors** on either width.
- The real LIFF ID appears in the shipped entry bundle, so the LINE branches
  compiled in rather than being optimised out by an empty build arg.

**Not verified:** the **authenticated** dashboard over this image. Signing in
requires the owner's production password, which was not requested, copied off the
VM, or handled. Unauthenticated, `/api/me` answers 401 correctly and every
report route is registered and denying properly, so nothing in the merge blocks
authentication — but "the dashboard renders for a signed-in owner" is carried
over from the `84da0f1` check against the **previous** image, not re-established
against this one. The narrower-grant path (single-branch `manager` or
`technician`, revenue redaction, zero-grant denial) remains unit-verified only,
because no such production account exists yet.

### Other state on the VM

`laundrytwin-app-1` up 12 minutes, **0 restarts**, no errors in its log. `etl`
(23h), `gas` (23h) and `weather` (45h) were not touched and kept their uptime;
`gas` still runs behind its `profiles: ["gas"]`. SQLite was backed up through
`await db.backup(...)` before the cutover — **not** `cp`, because the database is
in WAL mode and a file copy yields a plausible stub with zero rows — and verified
with `integrity_check`, a table count and per-table row counts. The backup file is
`backup-pre-merge-20261001T124223Z.sqlite` on the VM.

Also on the VM, as rollback material: `compose.yaml.bak-pre-merge-20261001` and
`.env.bak-pre-merge-20261001`. On the Pi: `Caddyfile.bak-pre-merge-20261001`.

### Rollback

Restore `/opt/laundrytwin/compose.yaml.bak-pre-merge-20261001` and
`/opt/laundrytwin/.env.bak-pre-merge-20261001`, bring the pair back up, then
repoint **both** Caddy lines to `10.10.0.117:8080` and recreate the Caddy
container. Rolling the app back without rolling Caddy back leaves the route
pointing at `:8787` with nothing listening; the two are one change, not two.

### Also shipped in this image, previously unverified in production

The machines-page state-claim fix (`1bda914`, `ab4d884`) and the direct-grant
route (`56e9e33`) ride along in the same image. `POST /api/admin/grants` is
registered and returns 401 unauthenticated; granting an account that already
exists still needs a single-branch production account to be created before
branch scoping can be verified against anything but unit tests.

## `deploy-9925087-20261002` — the closed-branch mechanism reaches production

**Status: deployed.** Commit `9925087`, image `laundrytwin:deploy-9925087-20261002`
(`sha256:a9561a33…`, 208 MB, `linux/amd64`, built on VM 117 from
`apps/api/Dockerfile` with `--build-arg VITE_LIFF_ID=2011592166-uToRdTwS`).
Rollback target `deploy-97c45ac-20261001`, retained on the VM.

This ships the **reader** for the hours provisioned the day before. It changes
no machine pill — see "What this deploy does not prove" below, which is the
honest framing.

### Caddy was not touched, and that is the difference from the last deploy

`deploy-97c45ac` had to repoint two `reverse_proxy` lines from `:8080` to
`:8787` and therefore had to **recreate** the Caddy container, blipping every
hostname it serves. Nothing here changes the port or the Caddyfile, so the
deploy is a single `docker compose up -d app` and Caddy was left alone. Had
this deploy also needed a Caddy change, the two would still be one rollback
unit, not two.

### Pre-deploy state captured before the swap

Taken over public TLS on both hostnames, so the post-deploy comparison is
against a measurement rather than a recollection:

| Check | Baseline |
| :--- | :--- |
| `/health` | 200 `application/json`, `{"ok":true,"reportingConfigured":false,"demoMode":false}` |
| `/`, `/login` | 200 `text/html; charset=utf-8` |
| `/api/me` | 401 |
| entry bundle | `index-10WERJ5R.js` |

### SQLite backup — the WAL trap, avoided and verified

The main file is **4,096 bytes** and the WAL **2.18 MB**, so `cp` would have
produced a plausible stub with zero rows. Backed up through the online API
(`await db.backup(...)`) to `/data/backup-pre-closedbranch-20261002T050514Z.sqlite`,
then verified rather than assumed: **196,608 bytes, `integrity_check: ok`, 15
tables, 3 users, 3 access grants.** A copy-sized backup is a failed backup, not
a small one. `.env` also copied to `.env.bak-pre-closedbranch-20261002`.

### Smoke after the swap

Every status matches the baseline exactly, on both hostnames.

| Check | Before | After |
| :--- | :--- | :--- |
| `/health` | 200 `application/json` | **200, byte-identical body** |
| `/`, `/login`, `/terms` | 200 `text/html; charset=utf-8` | **200, same type** |
| `/playground` | 200 | **200 `text/html`** |
| `/api/report/{branches,dashboard,live,alerts,events,summary}` unauth | 401 ×6 | **401 ×6** |
| `/api/me` unauth | 401 | **401** |
| `POST /api/admin/grants` unauth | 401 | **401** |
| `POST` to an unknown `/api/*` path | 404 | **404** |
| `/api/__smoke__` | 404 `text/plain` | **404 `text/plain`** |
| `%2e%2e%2f…/etc/passwd` | 404 | **404** |
| entry bundle | `index-10WERJ5R.js` | **`index-RH0VqymO.js`** |

`laundrytwin-app-1` **0 restarts**, started `2026-10-02T05:08:47Z`, log is a
single clean line (`LaundryTwin API listening on http://localhost:8787`).

### The shipped bundle carries the feature

The new build emits `dist/assets/branch-availability-view-hAU55Gx0.js`, so the
closed-branch view code-split into a real chunk rather than being tree-shaken
away. The image was also checked from **inside** the running container, and the
app's own `buildBranchHoursSQL` was executed with the app's own `reader`
credential against production ClickHouse (`26.3.26.3`, 8,158 usage rows) —
returning the provisioned row `0 / 1440 / []` for the real branch on **both** the
scoped and the tenant-wide (`branchId: ""`) paths. The reader is therefore
proven to reach the table, not merely assumed to.

### In a real browser, against the public route

Chromium at 390px and 1440px over TLS, no fixtures:

- `/login` renders the real page — password input present, **no**
  `.liff-message-card` (which would mean the LIFF gate had replaced it again).
- Hard navigation to `/privacy` boots the app: `lang="th"`, `#root` populated,
  `document.fonts.check` true for the vendored Noto Sans Thai.
- No horizontal overflow at 390px (`scrollWidth - clientWidth === 0`).
- **Zero page errors and zero console errors** at both widths.

### What this deploy does not prove

**No machine pill changed appearance, and none could have.** The provisioned
hours are 24/7, so `branchOpenState` resolves `open` at every minute and
`effectiveAvailability("unavailable", "open")` stays `unavailable`. The red
`ไม่พร้อมใช้งาน` cards remain, which is correct: the measurements showed the
branch really was trading. **The `closed` rendering was not observed in
production and cannot be** for this branch — that path is reachable only where a
schedule positively says the branch is shut. It stays covered by the 38 API
tests, the 15 web tests, and `e2e/closed-branch-honesty.pw.ts` against the built
bundle. Read this deploy as "the reader ships and works", not as "the closed
state was seen working".

The **authenticated** dashboard is also not re-established against this image:
signing in needs the owner's production password, which was not requested or
handled. Unauthenticated, `/api/me` and every report route deny correctly and
the SPA renders, so nothing in this change blocks authentication.

### Rollback

`APP_IMAGE=laundrytwin:deploy-97c45ac-20261001` in `/opt/laundrytwin/.env`, then
`docker compose up -d app`. **Caddy needs no rollback** — it was not part of
this change, unlike `deploy-97c45ac`, where app and Caddy were one unit.
