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
  `temperature.occurred_at` are advanced only *after* a batch commits, so a
  failed run retries the same window.
- **ReplacingMergeTree keyed by `source_event_id`** applies to
  `fact_machine_usage` only. `fact_temperature_sample` is a plain `MergeTree`
  ordered by `(tenant_id, branch_id, occurred_at, event_id)`, so re-reading a
  temperature row inserts a second copy. The temperature read therefore never
  re-reads a window it has already loaded — see the cursor note below.

## Temperature read: why `occurred_at` (2026-09-29)

The production ETL hung for four days from 2026-09-25 12:21 UTC. The container's
`node` process had burned 4 s of CPU in total, `RestartCount=0`, and
`docker logs` showed only successful `ETL complete:` lines: a query blocked in
Postgres, not a crash.

The temperature read paginated on `(ingested_at, seq, event_id)`. In IRIS
`machine_temperature_sample` is `PARTITION BY RANGE (occurred_at)`, so a
predicate on `ingested_at` prunes nothing and touches every partition; the table
has an index on `occurred_at` and **no index on `ingested_at`** anywhere in its
migration history; and it has no retention (IRIS's rotate cron covers
`machine_event` only), so each page scanned a table that only grew. The read now
keys on `occurred_at` — indexed, and the partition key — inside a range bounded
by a lag guard.

Two consequences worth knowing:

- **The cursor format changed.** `temperature.at` is now `occurred_at` and
  carries `"key": "occurred_at"`. A watermark written before 2026-09-29 is
  loaded as a legacy `ingested_at` cursor and re-anchored once, by looking up
  the last row at or before the old position; it is never reinterpreted in
  place, because an `ingested_at` value used as an `occurred_at` boundary would
  skip every row between the two positions. The re-anchor runs one query without
  the index, on the first run only.
- **The lag guard is a correctness control, not a tuning knob.** On an
  `ingested_at` keyset a row could not be read before it existed. On an
  `occurred_at` keyset a row whose event time is older than the cursor but which
  lands in IRIS afterwards would sit permanently behind the cursor, so the read
  stops `ETL_TEMPERATURE_LAG_HOURS` (default 24) short of now. The real
  worst-case event-to-ingest delay in IRIS has never been measured from this
  repository.

## Failure budgets

`docker logs` carries a line per phase and per batch (`ETL phase=<name>
status=start|ok|failed`, `ETL phase=temperature batch=N …`), a run-start line
with the effective settings, and a phase that exceeds `ETL_PHASE_TIMEOUT_MS`
fails the run. See `.env.example` for every timeout and what it is sized
against.

## Run

```bash
cp apps/etl/.env.example .env        # then fill PG_CONNECTION_STRING etc.
pnpm --filter @laundrytwin/etl start # or: pnpm --filter @laundrytwin/etl exec tsx src/index.ts
```

Requires a read-only role on `iris_project` and write access to the
LaundryTwin ClickHouse database. On a fresh watermark, set
`ETL_SINCE_FALLBACK_DAYS` to backfill history (e.g. `30`) — but read the risk
note in `docs/02_architecture/deploy-runbook.md` first: a large fallback window
is only safe while the watermark file exists, and the deployed Terraform default
for it is 30 days.

## Checks

```bash
pnpm --filter @laundrytwin/etl check
pnpm --filter @laundrytwin/etl test
```
