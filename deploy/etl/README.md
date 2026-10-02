# LaundryTwin ETL deployment (VM 117)

VM 117 (laundrytwin, 10.10.0.117) runs the ETL as a **long-running compose service** that loops the batch every 5 minutes. The earlier systemd timer deployment was retired (units disabled but left in place for reference).

- **Service**: `etl` in `/opt/laundrytwin/compose.yaml`, managed with the rest of the stack via `sudo docker compose up -d`
# **Image**: built from the per-app `apps/etl/Dockerfile` via turbo prune
# (`apps/etl/Dockerfile` targets `etl` and `weather`), pushed to the internal
# registry, pulled on the VM by compose. No web/playground vite builds involved.
- **Network**: `network_mode: host` so the container reaches ClickHouse at `127.0.0.1:8123` and Postgres at `172.30.186.206:5432` via ZeroTier (`12ac4a1e71c984c4`, VM IP `172.30.191.48`)
- **Env**: `/opt/laundrytwin-etl/.env` (600, not in git) referenced by compose (`env_file`, overridable with `ETL_ENV_FILE`) with `PG_CONNECTION_STRING` and `CLICKHOUSE_*`
- **State**: `/opt/laundrytwin-etl/data/etl-watermark.json` (composite cursor `(created_at,id)` / `(ingested_at,seq,event_id)`), bind-mounted to `/data` so container restarts resume from the last committed batch
- **Loop**: container runs `while true; do pnpm --filter @laundrytwin/etl start:container; sleep 300; done` — a run takes seconds, then it idles until the next cycle

Manual run (one-shot, no loop): `sudo docker run --rm --network=host --env-file=/opt/laundrytwin-etl/.env -v /opt/laundrytwin-etl/data:/data $(sudo docker compose -f /opt/laundrytwin/compose.yaml config --format json | jq -r '.services.etl.image // "laundrytwin-etl:latest"')` — or simply `sudo docker compose -f /opt/laundrytwin/compose.yaml run --rm etl` (without the loop; the service's default command loops).

Logs: `sudo docker compose -f /opt/laundrytwin/compose.yaml logs -f etl`

Update code: sync `apps/etl`, `apps/etl/Dockerfile`, `compose.yaml`, and lockfile to `/opt/laundrytwin`, then build+push the image from the Mac (`docker buildx build --platform linux/amd64 -f apps/etl/Dockerfile -t registry.laundrytwin.duckdns.org/laundrytwin-etl:latest --push .` with `~/.creds/laundrytwin-registry.txt` creds; the Mac cannot push via the internal `10.10.0.117:5000` IP) and `sudo docker compose pull etl && sudo docker compose up -d etl` on the VM (the VM pulls via `127.0.0.1:5000`, the same registry — the public duckdns IP fails from the VM, no NAT loopback).

**If those creds are absent, do not improvise a login — transfer the image.**
`~/.creds/laundrytwin-registry.txt` did not exist on 2026-10-03, so the push
path above was unavailable. What was used instead, and what to reach for when
the creds are missing:

```sh
# on the Mac: build for the DEPLOY arch, then stream it over ssh
docker buildx build --platform linux/amd64 --target etl \
  -f apps/etl/Dockerfile -t laundrytwin-etl:deploy-<sha>-<date> --load .
# verify it runs BEFORE it goes near the VM
docker run --rm --platform linux/amd64 --entrypoint sh laundrytwin-etl:deploy-<sha>-<date> \
  -c 'uname -m; node -v; ls src/'
docker save laundrytwin-etl:deploy-<sha>-<date> | gzip -1 | ssh <vm> 'cat > /tmp/etl-new.tar.gz'
# on the VM: tag the CURRENT image as the rollback target BEFORE retagging latest
sudo docker tag 10.10.0.117:5000/laundrytwin-etl:latest laundrytwin-etl:rollback-<digest>-<date>
gzip -d < /tmp/etl-new.tar.gz | sudo docker load
sudo docker tag laundrytwin-etl:deploy-<sha>-<date> 10.10.0.117:5000/laundrytwin-etl:latest
sudo docker compose up -d etl
```

Two things this buys over the registry. It needs no credential at all, so it
works when `~/.creds` is missing — which is the situation it was written for.
And `--platform linux/amd64` is not optional: the deploy host is amd64 with **no
binfmt emulation**, so an arm64 image dies with `exec format error` and, under
`restart: unless-stopped`, becomes a silent restart loop rather than a failed
deploy.

## Holding the ETL still for a warehouse migration

`hold-etl-for-warehouse-migration.sh` stops the ETL for a column-rebuild
migration of `fact_machine_usage` and always starts it again.

This is not optional tidiness. The ETL writes usage rows on a 5-minute cycle,
and the migration renumbers `status` by adding a column, backfilling it with a
mutation, and renaming. A ClickHouse mutation only rewrites the parts it
snapshotted, so a row written after that snapshot is not backfilled, and the
rename then reclassifies it — silently, with no error on the write or the read.
Reproduced on a scratch table on 2026-09-29: a `paid` row came out of the swap
as `pending_payment`, taking a cycle out of `status IN ('paid','finished')` and
a discovered only by noticing a number.

The migration also drops and rebuilds the `proj_by_time` projection
(`deploy/analytics/clickhouse-tuning.sql`), so the window is longer than a
single statement.

```sh
sudo sh deploy/etl/hold-etl-for-warehouse-migration.sh stop
# ... run the migration ...
sudo sh deploy/etl/hold-etl-for-warehouse-migration.sh start
sudo sh deploy/etl/hold-etl-for-warehouse-migration.sh status
```

Or `run -- <command>`, which stops, runs, and resumes in one shell with the
resume on an `EXIT`/`INT`/`TERM` trap so a failing migration cannot leave
ingestion stopped. Either way, **check `status` afterwards**: a stopped ETL
writes no logs and is indistinguishable from a healthy idle one by inspection.
The watermark resumes from where it stopped, so the worst outcome of a pause is
that ingestion is a few seconds late.
