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

1. **The `reader` password value.** It exists only on VM 117 — in
   `/opt/laundrytwin/.env` and `/opt/analytics/.env` (both installed mode 0600
   from the untracked `clickhouse_reader_password` Tofu variable) and, per the
   `Caddy config` section above, in the git-ignored
   `/opt/analytics/clickhouse-reader.local.xml`. Retrieve it over the
   documented SSH access and export it into the shell for the run; do not paste
   it into a ticket, a commit, or a shell history that is shared. The repo ships
   only the placeholder `deploy/analytics/clickhouse-reader.xml`, which takes
   the password `from_env`.
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
`docs/04_traceability/RTM_matrix.md` ("Canonical cycle definition"). A run that
reproduces `1 row per session`, `0 multi-status sessions`, and a `฿/cycle` near
฿40–45 for the row count confirms the decision. A run that does **not** is new
evidence: the attribution gap upstream may have changed, and the finding needs
re-deciding on the new numbers rather than being assumed still valid.

The diagnostic itself deliberately changes no query, type, label, or KPI, so no
number in the product moves as a result of running it.

## Troubleshooting quick reference

| Symptom | Likely cause | Check |
| :------ | :----------- | :---- |
| Public hosts down, ZeroTier IPs up | Pi ↔ VM ZeroTier link | `zerotier-cli listpeers` (Pi), `sudo zerotier-cli status` (VM) |
| One host 502 | That container down | `sudo docker ps` on VM; `sudo docker compose -f /opt/analytics/compose.yaml ps` |
| Cert expired | Caddy renewal blocked (HTTP-01 needs port 80 through) | `curl -vI ... \| grep -i expire`; Pi Caddy logs |
| Superset login loops | Authentik outpost / group membership | `auth.notnotik.duckdns.org` reachable; user in `final project member` |
| App shows demo data | Explicit preview mode with demo session cookie | `https://laundrytwin.duckdns.org/health` → `"demoMode":true`; check `LAUNDRYTWIN_DEMO_MODE` and preview-only intent |
| Airflow DAGs not running | Scheduler heartbeat stale | `curl http://127.0.0.1:8081/api/v2/monitor/health` — restart the stale role container |
| `database is locked` anywhere | SQLite metadata (should be gone) | Airflow + Superset metadata must live on analytics-postgres-1 |
| docker login to registry fails | Double auth on Caddy | Caddy block for registry must NOT add basic_auth |
