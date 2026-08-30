# LaundryTwin ETL deployment (VM 117)

VM 117 (laundrytwin, 10.10.0.117) runs the ETL as a **long-running compose service** that loops the batch every 5 minutes. The earlier systemd timer deployment was retired (units disabled but left in place for reference).

- **Service**: `etl` in `/opt/laundrytwin/compose.yaml`, managed with the rest of the stack via `sudo docker compose up -d`
- **Image**: built on the VM from root `Dockerfile` target `etl` (lightweight `etl-build` stage: no web/playground vite builds, so rebuilds only need the cached pnpm deps layer plus `apps/etl`)
- **Network**: `network_mode: host` so the container reaches ClickHouse at `127.0.0.1:8123` and Postgres at `172.30.186.206:5432` via ZeroTier (`12ac4a1e71c984c4`, VM IP `172.30.191.48`)
- **Env**: `/opt/laundrytwin-etl/.env` (600, not in git) referenced by compose (`env_file`, overridable with `ETL_ENV_FILE`) with `PG_CONNECTION_STRING` and `CLICKHOUSE_*`
- **State**: `/opt/laundrytwin-etl/data/etl-watermark.json` (composite cursor `(created_at,id)` / `(ingested_at,seq,event_id)`), bind-mounted to `/data` so container restarts resume from the last committed batch
- **Loop**: container runs `while true; do pnpm --filter @laundrytwin/etl start:container; sleep 300; done` — a run takes seconds, then it idles until the next cycle

Manual run (one-shot, no loop): `sudo docker run --rm --network=host --env-file=/opt/laundrytwin-etl/.env -v /opt/laundrytwin-etl/data:/data $(sudo docker compose -f /opt/laundrytwin/compose.yaml config --format json | jq -r '.services.etl.image // "laundrytwin-etl:latest"')` — or simply `sudo docker compose -f /opt/laundrytwin/compose.yaml run --rm etl` (without the loop; the service's default command loops).

Logs: `sudo docker compose -f /opt/laundrytwin/compose.yaml logs -f etl`

Update code: sync `apps/etl`, `Dockerfile`, `compose.yaml`, and lockfile to `/opt/laundrytwin`, then `sudo docker compose build etl && sudo docker compose up -d etl`. Rebuilds skip web/playground vite entirely.

Alternative image path (cross-arch from Mac): `docker build --platform linux/amd64 --target etl -t 127.0.0.1:5001/laundrytwin-etl:latest . && docker push 127.0.0.1:5001/laundrytwin-etl:latest` then pull on the VM via ZeroTier registry `172.30.115.153:5001`, or `docker save | ssh` for large images.
