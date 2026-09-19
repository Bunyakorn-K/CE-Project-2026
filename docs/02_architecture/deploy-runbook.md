# 🚀 LaundroTwin Deployment Runbook (public edge + TLS)

**Scope:** how the deployed stack is reachable publicly, where TLS terminates,
and what to do when something breaks. This documents the *observed* topology
(verified 2026-09-14). The TLS edge intentionally lives **outside** the repo's
OpenTofu module (see `deploy/tofu/README.md` out-of-scope notes) — it is the
home-lab Pi's job.

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
   ├─ laundrytwin-api-1        :8787  (Hono API + MCP server /mcp, demo mode by design)
   ├─ laundrytwin-etl-1        host   (batch ETL loop, IRIS Postgres → ClickHouse)
   ├─ laundrytwin-weather-1    host   (TMD weather collector loop, every 5 min)
   ├─ laundrytwin-registry     :5000  (docker registry v2, htpasswd auth)
   ├─ analytics-superset-1     :8088  (Superset, fronted by Authentik SSO)
   ├─ analytics-airflow-webserver-1   :8081  (Airflow 3.x api-server — UI/API)
   ├─ analytics-airflow-scheduler-1   (scheduler, per-role service)
   ├─ analytics-airflow-triggerer-1   (triggerer, per-role service)
   ├─ analytics-airflow-dag-processor-1 (dag processor, per-role service)
   ├─ analytics-postgres-1     :5433  (Airflow + Superset metadata)
   ├─ analytics-clickhouse-1   :8123  (HTTP interface — ZeroTier only)
   ├─ analytics-redis-1        (Superset cache)
   ├─ analytics-mcp-inspector-1:6274  (MCP Inspector)
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
| `https://mcp.laundrytwin.duckdns.org` | mcp-inspector :6274 | MCP Inspector; `ALLOWED_ORIGINS` already set to this origin in compose |
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
    reverse_proxy http://172.30.191.48:6274
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
- **Demo mode is intentional:** `LAUNDRYTWIN_DEMO_MODE=true` on
  `/opt/laundrytwin/.env`; there is no `IRIS_READ_BASE_URL` on the public edge.
  The browser must never receive upstream credentials (AGENTS.md boundary).
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

## Troubleshooting quick reference

| Symptom | Likely cause | Check |
| :------ | :----------- | :---- |
| Public hosts down, ZeroTier IPs up | Pi ↔ VM ZeroTier link | `zerotier-cli listpeers` (Pi), `sudo zerotier-cli status` (VM) |
| One host 502 | That container down | `sudo docker ps` on VM; `sudo docker compose -f /opt/analytics/compose.yaml ps` |
| Cert expired | Caddy renewal blocked (HTTP-01 needs port 80 through) | `curl -vI ... \| grep -i expire`; Pi Caddy logs |
| Superset login loops | Authentik outpost / group membership | `auth.notnotik.duckdns.org` reachable; user in `final project member` |
| App shows demo data | By design | `https://laundrytwin.duckdns.org/health` → `"demoMode":true` |
| Airflow DAGs not running | Scheduler heartbeat stale | `curl http://127.0.0.1:8081/api/v2/monitor/health` — restart the stale role container |
| `database is locked` anywhere | SQLite metadata (should be gone) | Airflow + Superset metadata must live on analytics-postgres-1 |
| docker login to registry fails | Double auth on Caddy | Caddy block for registry must NOT add basic_auth |
