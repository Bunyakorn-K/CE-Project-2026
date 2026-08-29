# @laundrytwin/etl

Batch ETL that copies durable machine-usage data from the IRIS Postgres
database (`iris_project`) into the LaundryTwin ClickHouse analytics warehouse —
the exact tables read by `apps/api` analytics (`fact_machine_usage`,
`fact_temperature_sample`, `dim_branch`, `dim_machine`).

## Why this exists

The LaundryTwin analytics queries already target ClickHouse, but nothing
populates it from real machine data in this repository. This package is that
loader. It reads from the **main IRIS `iris_project` Postgres** (the durable
data; the v2 `iris_v2` database is currently empty) and writes the tables that
`apps/api/src/analytics/queries.ts` expects.

## Source mapping (Postgres -> ClickHouse)

| ClickHouse target (schema.ts) | Postgres source | Notes |
| --- | --- | --- |
| `fact_machine_usage` | `machine_usage` 1:1 | `amount_satang` kept as integer satang; `source_event_id` is the idempotency key |
| `fact_temperature_sample` | `machine_temperature_sample` | `temperature_c` computed from `Fahrenheit`; `source_event_id = event_id` |
| `dim_branch` | `branch` | full resync each run |
| `dim_machine` | `machine` (deleted machines dropped) | full resync each run |

## Idempotency

- **Incremental by watermark** (`etl-watermark.json`): `usage.created_at` and
  `temperature.ingested_at` are advanced only *after* a batch commits, so a
  failed run retries the same window.
- **ReplacingMergeTree keyed by `source_event_id`**: even an overlapping
  re-insert converges to one row per source event.

## Run

```bash
cp apps/etl/.env.example .env        # then fill PG_CONNECTION_STRING etc.
pnpm --filter @laundrytwin/etl start # or: pnpm --filter @laundrytwin/etl exec tsx src/index.ts
```

Requires a read-only role on `iris_project` and write access to the
LaundryTwin ClickHouse database. On a fresh watermark, set
`ETL_SINCE_FALLBACK_DAYS` to backfill history (e.g. `30`).

## Checks

```bash
pnpm --filter @laundrytwin/etl check
pnpm --filter @laundrytwin/etl test
```