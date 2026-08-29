# LaundryTwin ETL deployment (VM 117)

VM 117 (`laundrytwin`, 10.10.0.117) runs the ETL as a container via systemd timer.

- **Image**: `laundrytwin-etl:latest` (built from root `Dockerfile` target `etl`, `linux/amd64`)
- **Registry**: local registry on VM (`10.10.0.117:5000`) and on Mac via ZeroTier (`172.30.115.153:5001`) for distribution. VM pulls via ZT or via `docker save | ssh` when cross-arch.
- **Network**: `--network=host` so the container reaches ClickHouse at `127.0.0.1:8123` and Postgres at `172.30.186.206:5432` via ZeroTier (`12ac4a1e71c984c4`, VM IP `172.30.191.48`).
- **Env**: `/opt/laundrytwin-etl/.env` (600, not in git) with `PG_CONNECTION_STRING` (no `?sslmode` param, `ssl:{rejectUnauthorized:false}` in code) and `CLICKHOUSE_*`.
- **State**: `/opt/laundrytwin-etl/data/etl-watermark.json` (composite cursor `(created_at,id)` / `(ingested_at,seq,event_id)`), persisted across runs.
- **Schedule**: `laundrytwin-etl.timer` every 5min (`OnBootSec=2min`, `OnUnitActiveSec=5min`).

Manual run: `sudo systemctl start laundrytwin-etl.service` or `sudo docker run --rm --network=host --env-file=/opt/laundrytwin-etl/.env -v /opt/laundrytwin-etl/data:/data laundrytwin-etl:latest`

Update image: on Mac `docker build --platform linux/amd64 --target etl -t 127.0.0.1:5001/laundrytwin-etl:latest . && docker push 127.0.0.1:5001/laundrytwin-etl:latest` then on VM `sudo docker pull 172.30.115.153:5001/laundrytwin-etl:latest && sudo docker tag 172.30.115.153:5001/laundrytwin-etl:latest laundrytwin-etl:latest` (or via `docker save | ssh` for large images).
