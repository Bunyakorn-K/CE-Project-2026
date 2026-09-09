# Ops Verification — 2026-09-09

## F-12 weather collector deploy (finishing interrupted session 2026-09-06)

Deployed the weather collector amd64 image to VM 117 and completed the
container registry subdomain setup that was interrupted mid-session.

### Weather collector (F-12) — deploy

| Step | Action | Result |
|------|--------|--------|
| 1 | Confirmed Mac image `localhost:5000/laundrytwin-weather:latest` was amd64 (`f1cfdef7526d`, arch=amd64) | OK |
| 2 | `docker save` → scp 517M tar → VM `/tmp/weather-image-amd64.tar` | OK |
| 3 | `docker load` on VM (nohup, survived ssh timeout) → image `f1cfdef7526d` | Loaded, replaced stale arm64 image |
| 4 | Tag `laundrytwin-weather:latest` + `docker compose up -d weather` | Container started |
| 5 | Healthcheck was `health=unhealthy` — image lacks `ps` (`/bin/sh: 1: ps: not found`) | Root-caused |
| 6 | Fixed compose.yaml healthcheck → `["CMD-SHELL", "kill -0 1 2>/dev/null || exit 1"]`, rsync to VM, `up -d --no-deps weather` | Verified `kill -0 1` works in container (PID 1 = sh) |
| 7 | Post-change smoke: `health=healthy`, logs show `Weather collection complete: {"fetched":2,"rows":2,"provinces":["เชียงใหม่","ชลบุรี"]}` | Healthy |
| 8 | ClickHouse `fact_weather_sample`: each province 38 rows (was 37 before restart → new UTC rows appended), max `2026-09-08 20:00:00.000` UTC | Data flowing, UTC correct |

Rollback target: prior arm64 image was removed; the amd64 image is identical
code, tag `laundrytwin-weather:latest` + registry copy
`127.0.0.1:5000/laundrytwin-weather:latest` remain on VM.

### Container registry subdomain — registry.laundrytwin.duckdns.org

| Step | Action | Result |
|------|--------|--------|
| 1 | Diagnosed Pi→VM:5000 timeout: PVE `NOTNOTIK_10NET_GUARD` chain allowlists only declared ports; 5000 missing | Root-caused (not VM/pve-firewall — both disabled/ACCEPT) |
| 2 | Added `--dport 5000` ACCEPT for `192.168.88.10` to `/usr/local/sbin/notnotik-private-network-firewall` + `systemctl restart` | Pi→`10.10.0.117:5000` = 200 |
| 3 | Recreated `laundrytwin-registry` (`registry:2`) with htpasswd auth: `/srv/registry/{config.yml,htpasswd}`, `-v registry-data`, mount config + htpasswd ro | 401 without creds / 200 with creds on VM |
| 4 | Added Caddy site `registry.laundrytwin.duckdns.org { import hide-server; reverse_proxy 10.10.0.117:5000 }` to live `/home/dietpi/stack/caddy/Caddyfile` (backup `Caddyfile.bak-registry-20260909`) | `caddy validate` = valid; `docker restart caddy` |
| 5 | Public smoke: no creds → 401, with creds → 200; existing sites intact (laundrytwin 200, immich 200) | OK |
| 6 | Mac: `docker login registry.laundrytwin.duckdns.org` + `docker push` weather image | Push succeeded, digest `sha256:75f2934f…` |
| 7 | VM pull: public IP fails (NAT loopback, `connection refused` — expected, same as Pi landmine); VM pulls via internal `127.0.0.1:5000` | Login + pull OK, same digest |

Rollback targets: Caddy `Caddyfile.bak-registry-20260909`; firewall script
`notnotik-private-network-firewall.bak-registry-5000`; registry recreated with
same volume — prior container config captured in session transcript.

### Notes / follow-ups

- `tryhard/notnotik` repo `homelab/pi/Caddyfile` is a stale sanitized reference
  (Sep 1, no laundrytwin sites); live file on Pi has diverged. Not touched.
- Creds for registry stored locally `~/.creds/laundrytwin-registry.txt` (0600);
  never commit.

## 2026-09-09 (later) — WEATHER_IMAGE param + compose-pull deploy + F-12 re-run

| Step | Action | Result |
|------|--------|--------|
| 1 | `compose.yaml` weather service: `image: ${WEATHER_IMAGE:-laundrytwin-weather:latest}`; VM `/opt/laundrytwin/.env` gets `WEATHER_IMAGE=10.10.0.117:5000/laundrytwin-weather:latest` | compose pull works from internal registry |
| 2 | `docker compose pull weather && up -d weather` on VM 117 | Recreated; container Up (healthy); digest pulled = pushed `sha256:75f2934f…` |
| 3 | Weather UTC continuity re-check | 50 rows/province, `2026-09-07 06:00` → `2026-09-09 07:00` UTC, 0 duplicate hours |
| 4 | TMD outage check | `data.tmd.go.th` unreachable from VM **and** Mac (upstream outage, not our deploy); container retries every 5 min, latest data 07:00 UTC |
| 5 | F-12 correlation re-run (UTC-aligned, Chiang Mai branch `5e9611c1…`, hourly join) | n=42 h: corr(temp,cycles)=**+0.164**, corr(rh,cycles)=**−0.120**, corr(rain,cycles)=+0.041 — direction stable vs first evaluation; below significance for n=42 (need r≥0.31); keep collecting toward ~7 days |

Rollback: previous weather image tag `laundrytwin-weather:latest` still on VM.
