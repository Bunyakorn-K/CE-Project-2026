# Analytics Dev Platform Design (Approach C)

Date: 2026-08-26
Status: Draft for team review
Requirements touched: F-04 (future consumer), F-08 (KPI Aggregation), F-11 (allow-listed functions precedent), F-12 (Weather API correlation, Phase 2)

## Purpose

Give every project member a way to contribute development work on the
analytics pillar without waiting for the upstream IRIS machine-usage export:

1. An allow-listed analytics REST layer on the existing Hono API that serves
   KPI, chart, and heatmap data from ClickHouse.
2. A self-serve API playground (OpenAPI + Scalar UI) so members can exercise
   endpoints with demo/read credentials and no frontend work.
3. A synthetic seed script so the ClickHouse tables have clearly labeled
   verification data during development.
4. Superset stays the internal BI / SQL Lab exploration surface. It is not a
   product surface; product charts consume the Hono endpoints.
5. Weather forecast ingestion from the Thai Meteorological Department NWP API
   (token already provisioned) powering a Phase 2 experimental
   weather-vs-usage correlation endpoint.

## Non-goals

- No real MQTT/Modbus ingestion in this repository. Real data arrives via the
  Airflow IRIS export designed separately; until then only labeled synthetic
  rows exist.
- No payment writes, machine commands, or telemetry producers.
- No causation or forecasting claims from weather data (F-12 boundary).
- No new frontend dashboard framework; the web app consumes JSON endpoints.

## Architecture

```text
LINE LIFF/browser ──► React web ──┬─► Hono API ──► SQLite (auth, grants, branch_location)
                                  │        │
                                  │        ├──► IRIS read API      (existing, optional)
                                  │        ├──► ClickHouse HTTP :8123  (analytics facts)
                                  │        └──► TMD NWP API (forecast, server-side only)
                                  │
Member playground: /docs (Scalar) ┘
Superset (existing VM) ──► ClickHouse  (BI exploration only)
```

The browser never receives the TMD token or the ClickHouse credential. Both
are server-side environment variables.

## Components

### 1. `apps/api/src/analytics/clickhouse.ts`

Minimal HTTP client over `fetch` to ClickHouse port 8123
(`CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` env vars).
Every query is a fixed parameterized template; values bind as ClickHouse query
parameters. No string interpolation of user input. No dynamic SQL builder.
Failure mode: non-2xx returns a typed error; endpoint maps it to 503 with a
generic message (never leaks credentials or SQL).

### 2. Analytics endpoints — `apps/api/src/analytics/routes.ts`

Mounted under `/api/v1/analytics`. All endpoints require a session (Better
Auth cookie or demo/read client). Branch scoping reuses the existing
`AccessGrant` model; `owner` sees all granted tenants' branches, others are
constrained to assigned branches. Revenue-bearing fields are additionally
gated by the existing `mayViewRevenue` check.

| Endpoint | Source table | RBAC |
|---|---|---|
| `GET /api/v1/analytics/revenue/daily?from&to&branchId` | `fact_machine_usage` JOIN `dim_branch` | owner/manager |
| `GET /api/v1/analytics/cycles/daily?from&to&branchId` | same | any role, scoped |
| `GET /api/v1/analytics/utilization/heatmap?from&to&branchId&grain=hour` | `fact_machine_usage` | any role, scoped |
| `GET /api/v1/analytics/temperature/curve?from&to&machineId` | `fact_temperature_sample` | technician+, scoped |
| `GET /api/v1/analytics/weather/forecast?branchId&days<=10` | TMD proxy (no storage required for this route) | any role, scoped |
| `GET /api/v1/analytics/weather-usage/correlation?branchId&from&to` | `fact_weather_daily` × `fact_machine_usage` | owner/manager; response marked `"experimental": true` |

Response envelope follows the existing reporting routes:
`{ meta: { range, branchScope, dataSource }, data: [...] }`. When the queried
window contains only synthetic rows, `meta.dataSource` is `"synthetic"` and
the web app must render its SYNTHETIC banner. Synthetic detection is by
`source_event_id LIKE 'synthetic:%'` aggregated into the meta field — the
endpoints never silently mix unlabeled data.

Validation limits: ranges capped at 90 days, heatmap grain fixed to hour,
correlation requires ≥14 days of paired data else returns
`422 insufficient_paired_data`.

### 3. Playground — OpenAPI + Scalar

Add `@hono/zod-openapi` and `@scalar/hono-api-reference`. Each analytics route
declares zod schemas (query params, responses) which generate `/api/openapi.json`.
Scalar UI mounts at `/docs` inside the API app and works with a demo session.
This is the member-facing playground: pick endpoint, paste demo token, execute,
see JSON. No separate service is created.

### 4. Synthetic seed — `apps/api/scripts/seed-analytics.ts`

Idempotent script inserting deterministic pseudo-random (seeded PRNG, fixed
seed committed in the script) rows into the existing ClickHouse schema:

- `dim_branch` / `dim_machine`: prefixed names `SYNTH-B01`, machines per branch.
- `fact_machine_usage`: 60 days of cycles with weekday/hour skew, statuses
  mostly `finished`/`paid`, attribution mixed, amounts in satang.
- `fact_temperature_sample`: dryer-shaped rise/fall curves.
- Every row: `source_event_id = 'synthetic:<uuid>'`.

The script refuses to run against a database containing non-synthetic rows
unless `--force` is passed, protecting future real data from contamination.

### 5. Weather — TMD client + storage

`apps/api/src/analytics/tmd-client.ts` wraps:

```text
GET https://data.tmd.go.th/nwpapi/v1/forecast/location/daily/at
    ?lat=<lat>&lon=<lon>&date=<YYYY-MM-DD>&duration<=10
    &fields=tc_min,tc_max,rh,rain,cond
authorization: Bearer $TMD_API_TOKEN
```

Behavior:

- Token read from env; requests fail closed if unset (endpoint returns 503
  `weather_provider_unconfigured`; nothing degrades to fabricated values).
- Branch without stored coordinates returns 422 `branch_location_missing`
  with a message pointing the owner to the branch-location route.
- 5-minute in-memory cache per (branch, date-range) to respect rate limits;
  HTTP 429 backs off and surfaces a typed error.
- Response mapping keeps TMD units: °C, %, mm, cond code integer. Condition
  codes map through an explicit lookup table (1..12 as documented by TMD);
  unknown codes persist raw and render as `unknown(<code>)`.

New ClickHouse DDL (added to the analytics schema doc):

```sql
CREATE TABLE IF NOT EXISTS fact_weather_daily (
    tenant_id UUID,
    branch_id UUID,
    forecast_date Date,
    issued_at DateTime64(3),
    lat Float32,
    lon Float32,
    tc_min Nullable(Float32),
    tc_max Nullable(Float32),
    rh Nullable(Float32),
    rain Nullable(Float32),
    cond Nullable(Int16),
    extracted_at DateTime64(3)
) ENGINE = ReplacingMergeTree(issued_at)
ORDER BY (tenant_id, branch_id, forecast_date);
```

Branch coordinates: new SQLite table `branch_location`
(`tenant_id`, `branch_id` PK pair, `latitude REAL NOT NULL`, `longitude REAL
NOT NULL`, `updated_at`). Owner manages values through a small CRUD route
`PUT /api/v1/analytics/branch-location` gated by `mayManageAccess`. Assumption
recorded: owners supply coordinates manually; no geocoding is built.

Important semantics preserved: TMD NWP returns **model forecasts**, not station
observations. Stored rows keep `issued_at` (when fetched) and `forecast_date`;
the correlation endpoint reports the source range and states in its response
docs that values are forecasts, satisfying F-12's "specify source data range
and explicitly state correlation limits" criterion. Correlation method is
Pearson r on daily aggregates with n reported; output text never implies
causation or forecast skill.

### 6. Member task split

Each item is independently mergeable behind the shared client/routes skeleton
(built first, by whoever picks task 0):

| # | Module | Deliverable |
|---|---|---|
| 0 | Skeleton | clickhouse client, route scaffolding, OpenAPI wiring, seed script |
| 1 | Revenue & cycles | two endpoints + tests + Scalar examples |
| 2 | Utilization heatmap | endpoint (hour×machine duration) + tests |
| 3 | Temperature curve | endpoint + tests |
| 4 | Weather | TMD client, ingest-to-table job, forecast proxy, branch-location CRUD |
| 5 | Correlation | weather×usage endpoint incl. insufficient-data path + docs |
| 6 | Docs page | playground usage guide under `docs/integration/` |

## Error handling

| Case | Behavior |
|---|---|
| ClickHouse unreachable | 503, logged once per burst, generic body |
| TMD 401/429/timeout | 503 `weather_provider_error` with retry-after hint on 429 |
| Missing token config | 503 `weather_provider_unconfigured` |
| Cross-branch request | 403, same as existing report routes |
| Empty window (real data absent) | 200 with empty `data` and honest `meta.dataSource`; never falls back to synthetic automatically |

## Testing

- Unit tests mock the ClickHouse client and TMD fetcher (vitest, matching repo
  pattern): parameter binding, RBAC matrix (technician denied revenue,
  cross-branch denied), synthetic-meta computation, cond-code mapping,
  correlation insufficient-data path.
- Seed script test asserts determinism (same seed → identical row hashes) and
  the refuse-without-`--force` guard.
- Contract test: OpenAPI document contains every mounted route.

## Security and invariants

- Money stays satang integers end to end; presentation divides by 100.
- No credentials in repo; `.env.example` gains
  `CLICKHOUSE_URL/USER/PASSWORD` and `TMD_API_TOKEN` placeholders only.
- Parameterized allow-listed queries only; this module is also the reference
  implementation pattern for F-11 tool functions later.
- Synthetic data always detectable and labeled; never auto-serves when real
  data exists.

## Verification

```bash
pnpm --filter @laundrytwin/api test
pnpm check && pnpm build
# manual: docker compose up clickhouse, pnpm seed, curl /api/openapi.json, open /docs
```

## Unresolved items

- ClickHouse location for local dev (docker compose file needed under `deploy/`)
  — deployment topology beyond local dev is out of scope here.
- Whether Superset embeds later in LIFF remains open; not assumed by this design.
- Rate-limit quota numbers for TMD are unpublished; the cache/backoff design
  assumes conservative use (~1 call per branch per 5 min worst case).
