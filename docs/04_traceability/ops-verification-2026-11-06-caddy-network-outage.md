# Ops verification — All `*.laundrytwin.duckdns.org` unreachable (2026-11-06)

## Symptom

Every public hostname under `*.laundrytwin.duckdns.org` — `laundrytwin`, `web`,
`superset`, `airflow`, `mcp`, `chat`, `registry`, `clickhouse`, `arcane` —
answered `Connection refused` from the Mac. DNS was correct (all A records →
`161.246.5.47`), but nothing accepted TCP on 80/443.

## Measured

| Check | Result |
|---|---|
| `dig laundrytwin.duckdns.org` | `161.246.5.47` — correct |
| `curl https://laundrytwin.duckdns.org/` from Mac | refused, all 9 hostnames |
| Pi → `http://172.30.191.48:8787/health` | `HTTP 200 {"ok":true}` — VM and app healthy |
| Pi host `ss -tlnp` for 80/443 | **no listener** — Caddy container running (`Up 3 days`) but nothing bound |
| Caddy `NetworkSettings.Networks` | `{}` — **empty** |
| `docker network inspect proxy` containers | hook, btc_dashboard, go2rtc — **caddy absent** |
| Caddy started | `2026-11-03T13:00:28Z` |
| Caddy logs | only ACME ARI warnings (`network is unreachable` to `[fd7a:115c:a1e0::53]`), no access errors |

## Root cause

The Caddy container on the Pi had lost its Docker network attachment. It was
still running (process alive, serving from memory, ACME maintenance ticking),
but attached to **no network**, so Docker published no port and nothing
listened on 80/443. The VM backend and the DuckDNS A records were both
correct throughout — this was purely the edge.

## Fix

```bash
sudo docker network connect proxy caddy   # on the Pi
```

No Caddyfile change, no container recreate, no rollback target — a network
re-attach only. A `docker restart caddy` was tried first and did **not**
restore the listener; the explicit `docker network connect` did.

**Why this mattered vs. a Caddyfile change:** Caddy on this Pi uses
`admin off`, so any Caddyfile edit forces a container recreate — which blips
*every* hostname Caddy serves, not just LaundryTwin. The network connect
blipped nothing (there was nothing listening to blip).

## Verification

From the Mac, after the reconnect:

| Host | HTTP |
|---|---|
| `laundrytwin.duckdns.org/` | 200 |
| `web.laundrytwin.duckdns.org/` | 200 |
| `superset.laundrytwin.duckdns.org/` | 302 (Authentik) |
| `airflow.laundrytwin.duckdns.org/` | 302 (Authentik) |
| `mcp.laundrytwin.duckdns.org/mcp` | 401 (auth, expected) |
| `chat.laundrytwin.duckdns.org/` | 200 |
| `registry.laundrytwin.duckdns.org/v2/` | 401 (htpasswd, expected) |
| `clickhouse.laundrytwin.duckdns.org/` | 200 |
| `arcane.laundrytwin.duckdns.org/` | 200 |
| `laundrytwin.duckdns.org/health` | `{"ok":true,"reportingConfigured":false,"demoMode":false}` |

From the Pi itself: `curl --resolve <host>:443:127.0.0.1
https://<host>/` → all 200/302/401 as above. (Plain
`curl https://127.0.0.1/` fails with a TLS alert — that is SNI rotation on a
bare IP, not a Caddy fault.)

## Still open

1. **Why Caddy lost its network on 2026-11-03.** Not investigated — Docker
   daemon restart, `docker network prune`, or a stack `compose down/up` are
   the likely candidates. This outage reads as "everything down" and nothing
   in the runbook covers it. See PRIORITY 1 (automated backup) and the
   troubleshooting table in `deploy-runbook.md`.
2. **ACME / DNS on the Pi.** Caddy logs every few minutes:
   `lookup acme-v02.api.letsencrypt.org on [fd7a:115c:a1e0::53]:53: connect:
   network is unreachable`. Certificates expire 2026-12 / 2027-01, so this
   is not urgent today, but a renewal attempted while this persists **will
   fail**. Investigate IPv6 routing / resolver on the Pi before then.
3. The VM (`172.30.191.48`) was unreachable over SSH from the Pi during this
   session (`Permission denied (publickey)` / timeouts) — separate from the
   Caddy fault; the app itself was verified healthy over HTTP from the Pi.
