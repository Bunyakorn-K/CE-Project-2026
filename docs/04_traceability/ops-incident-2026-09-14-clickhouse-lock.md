# Ops incident — ClickHouse restart loop (exit 76, stale status lock) 2026-09-14

## What happened

While gathering data-volume facts for R09 planning, `clickhouse-client`
against `analytics-clickhouse-1` started failing with "Container is
restarting". The container was in a crash loop: `Restarting (76)` every ~3 s,
restart count climbing (370+).

## Root cause (self-inflicted during debugging)

The exit code is 76 = `DB::Exception: Cannot lock file
/var/lib/clickhouse/status. Another server instance in same directory is
already running (CANNOT_OPEN_FILE)`.

Sequence that caused it:

1. A debug `docker run --entrypoint sh ... clickhouse-server --config-file
   ... &` was used to capture the server's stderr. The `&` backgrounded
   clickhouse-server INSIDE the throwaway container.
2. `sudo timeout 25 docker run ...` killed the docker CLIENT, not the
   container — and because the container had no attached foreground process,
   it kept running (and `--rm` only fires when the container exits on its
   own). The clickhouse-server process (host PID 3308665, elapsed 10+ min)
   survived on the host, holding the volume's `/var/lib/clickhouse/status`
   lock.
3. The compose container then could not acquire the lock → crash → restart
   loop. `docker inspect` showed OOMKilled=false and the cgroup showed
   `oom_kill=0` with unlimited memory, ruling out memory as the cause.

## Diagnosis path that worked

- `docker logs` stdout only shows config-merge lines (useless for this).
- The real error was in
  `/var/log/clickhouse-server/clickhouse-server.err.log` inside the
  container: `sudo docker cp analytics-clickhouse-1:/var/log/clickhouse-server/clickhouse-server.err.log /tmp/`
  immediately after `compose up -d clickhouse` (the cp raced the crash but
  the file was readable).
- `ps aux | grep [c]lickhouse-server` revealed the stray host process with a
  10-min elapsed time — the smoking gun.

## Fix

```bash
sudo kill -9 <stray-clickhouse-pid>            # orphaned instance
sudo docker rm -f analytics-clickhouse-1
sudo docker run --rm -v analytics_clickhouse-data:/data alpine rm -f /data/status
cd /opt/analytics && sudo docker compose up -d clickhouse
```

Container came back `Up ... (healthy)`; data intact (5,425 usage rows,
4 active branches, range 2026-07-22 → 2026-09-14).

## Lesson (also in skill `laundrytwin-ops`)

Never background clickhouse-server (`&`) inside a debug `docker run` — the
process outlives the debug container and grabs the volume status lock,
crashing the real container. If a ClickHouse container is in a `Restarting
(76)` loop, check `ps aux | grep clickhouse` for a stray process first, then
the status lock file.