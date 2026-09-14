# 💰 LaundroTwin Cost Analysis (Epic 1 · #39)

**Scope:** monthly cost estimate for the deployed stack, self-hosted baseline
vs cloud equivalents. All figures are estimates with explicit assumptions —
no vendor quotes were obtained; verify before procurement.

**Assumption snapshot:** deployment on VM 117 (PVE virtual machine, host CPU
AMD FX-8350, 8 cores, ~125 W TDP), compose stacks under `/opt`
(laundrytwin, analytics, arcane, librechat), internal docker registry on the
same VM, ZeroTier overlay, duckdns domain, LINE Official Account (Messaging
API). Data volumes (2026-09-06): 4.3k usages, 3.49M temperature samples;
freshness DAG runs every 5 min.

## 1. Self-hosted baseline (current)

| Item | Detail | Est. cost/mo |
| :--- | :----- | :----------- |
| Electricity (VM share) | FX-8350 idle→load ~80–150 W; assume 110 W avg × 24 h × 30 d ≈ 79 kWh; TH rate ~4.5–5.5 ฿/kWh | 355–435 ฿ (~$11–13) |
| Host amortization | Refurb FX-8350 board+CPU+RAM+SSD ≈ 6,000–10,000 ฿ / 36 mo | ~200–280 ฿ (~$6–9) |
| Domain (duckdns) | Free (dynamic DNS) | 0 |
| TLS (Let's Encrypt via Caddy) | Free | 0 |
| Docker registry (self-hosted, `registry:2`) | Free (same VM) | 0 |
| LLM API (OpenRouter free tier + Bifrost gateway) | Free model used for testing (`inclusionai/ling-3.0-flash-fin:free`); paid usage only if a paid model is chosen | 0 (baseline) |
| LINE Official Account + Messaging API | Free tier (push via Messaging API, no LINE Notify) | 0 |
| Storage | ClickHouse data + Postgres metadata (Airflow/Superset) + Mongo/Meili (LibreChat) on host disks | included in amortization |
| **Total self-hosted** | | **~555–715 ฿ (~$17–22)/mo** |

Notes:

- Electricity is the dominant running cost; the FX-8350 host is idle most of
  the day (stack idle ≈ 80 W).
- No PII/hardware purchase beyond the existing host is assumed.
- Backups: `/opt/backups` volume on same host — a second disk would add
  ~100–200 ฿/mo (not included).
- Since 2026-09-13 the Airflow + Superset metadata live on a local Postgres
  (`analytics-postgres-1`) instead of SQLite — same host, no new cost.

## 2. Cloud equivalent (comparator — what it would cost managed)

| Service | Equivalent role | Est. cost/mo (USD) |
| :------ | :-------------- | :----------------- |
| Small cloud VM (2 vCPU / 4 GB) | app + web + ETL + scheduler | $10–20 |
| ClickHouse Cloud (small, ~50 GB) | analytics warehouse | $50–100 (dev tier can be lower) |
| Managed Airflow (Astronomer/cloud) | DAG orchestration | $50–150 |
| Superset as-a-service | BI | $0–50 (self-host in same VM) |
| Postgres managed (×2: Airflow + Superset) | metadata | $10–50 |
| Mongo Atlas / managed search | LibreChat metadata + Meilisearch | $10–30 |
| Managed docker registry (ECR/GHCR) | image registry | $0–5 |
| Domain + TLS + CDN | duckdns + Caddy + Let's Encrypt | $0–12 |
| **Total managed** | | **~$130–370/mo** |

The managed path is roughly **7–20× the self-hosted cost**; the self-hosted
stack is therefore the cost-optimal choice for a capstone/small-franchise
deployment. Managed services buy: no on-prem electricity, HA, upgrades,
support — none of which are MVP requirements today.

## 3. Scale-out trigger (when to stop self-hosting)

| Trigger | Threshold |
| :------ | :-------- |
| Branches | > 10 branches (VM sizing + ops burden grows linearly) |
| Temperature samples | > 50M rows/mo (ClickHouse on this host: disk + merge pressure) |
| Concurrent users | > 20 concurrent dashboard users (FX-8350 single-host limits) |
| Uptime SLA | any contractual uptime commitment |

Beyond any one trigger, move ClickHouse + Airflow to managed tiers and keep
the app on a small VM.

## 4. Mitigations already in place (keep running cost low)

- gzip API responses + esbuild bundle → lower egress/CPU.
- Redis-backed Superset caches → chart queries are cached, not re-run.
- ETL watermark → incremental loads only (no full re-scan).
- Freshness DAG every 5 min → bounded polling cost.
- ZeroTier for admin paths → public edge serves only the demo UI.
- Per-app images via turbo prune + minimal alpine runtime (~29–69 MB) →
  registry traffic/storage stays small.
- Free OpenRouter model pinned for tool-testing agents.

## Maintenance rules

- Update figures when hardware, tariffs, or data volumes materially change.
- Re-validate cloud quotes before any migration decision (vendor pricing moves).
- Keep money as integer satang in any cost model derived from revenue data.