# 🚀 LaundroTwin Deployment Runbook (public edge + TLS)

**Scope:** how the deployed stack is reachable publicly, where TLS terminates,
and what to do when something breaks. This documents the *observed* topology
(verified 2026-09-06). The TLS edge intentionally lives **outside** the repo's
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
   ├─ laundrytwin-api-1        :8787  (Hono API, demo mode by design)
   ├─ analytics-superset-1     :8088  (Superset, fronted by Authentik SSO)
   ├─ analytics-airflow-1      :8081  (Airflow webserver)
   ├─ analytics-mcp-inspector-1:6274  (MCP Inspector)
   └─ analytics-clickhouse-1   :8123  (HTTP interface — ZeroTier only)
```

## DNS (duckdns.org)

All four hosts resolve to the same public IP (verified `dig`):

| Host | A record |
| :--- | :------- |
| `laundrytwin.duckdns.org` | 161.246.5.47 |
| `superset.laundrytwin.duckdns.org` | 161.246.5.47 |
| `airflow.laundrytwin.duckdns.org` | 161.246.5.47 |
| `mcp.laundrytwin.duckdns.org` | 161.246.5.47 |

Add/remove hosts at https://duckdns.org (token is per-domain; keep it in the
Pi's duckdns updater, not in this repo).

## Public host → service mapping

| URL | Backend on VM | Notes |
| :-- | :------------ | :---- |
| `https://laundrytwin.duckdns.org` | web :8080 | SPA + `location /api/` → api:8787 (in-stack nginx, `deploy/nginx.conf`); `location = /webhooks/line` → api |
| `https://superset.laundrytwin.duckdns.org` | superset :8088 | **Authentik SSO in front** — Caddy → Authentik outpost (`auth.notnotik.duckdns.org/application/o/authorize/...`) → superset. Only members of the `final project member` group can sign in. |
| `https://airflow.laundrytwin.duckdns.org` | airflow :8081 | Airflow login (`admin` + `AIRFLOW_ADMIN_PASSWORD` from `/opt/analytics/.env`) |
| `https://mcp.laundrytwin.duckdns.org` | mcp-inspector :6274 | MCP Inspector; `ALLOWED_ORIGINS` already set to this origin in compose |

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
```

If Authentik is in front of Superset, replace the superset block with the
outpost's own proxy settings (Authentik outpost normally handles it).

## Operational notes

- **ZeroTier is load-bearing:** the Pi reaches the VM over 172.30.191.0/24.
  If the VM drops off ZeroTier, all four public hosts go down even though the
  containers are healthy. First check: `zerotier-cli listpeers` on the Pi and
  `sudo zerotier-cli status` on the VM.
- **Demo mode is intentional:** `LAUNDRYTWIN_DEMO_MODE=true` on
  `/opt/laundrytwin/.env`; there is no `IRIS_READ_BASE_URL` on the public edge.
  The browser must never receive upstream credentials (AGENTS.md boundary).
- **No TLS inside the stack:** `deploy/nginx.conf` listens on :80 only; TLS
  terminates on the Pi. Do not add TLS to the in-stack nginx.
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
