# LaundryTwin Repository Guide

## Purpose and authority

This repository is the CE Project 2026 workspace for the Smart Laundry
Management and Analytics Platform, also called LaundryTwin. It contains both
the project requirements and the current LaundryTwin application.

The current application is a LINE LIFF reporting surface that is read-only with
respect to IRIS, machine commands, and payment data. Local access grants,
alert acknowledgements, sessions, and AI settings are writable. It is a starting
implementation and does not yet satisfy every target requirement. Never
describe a requirement as implemented unless code and verification evidence in
this repository support that claim.

Direct user instructions take precedence over this guide.

## Repository identity

- Canonical repository: `https://github.com/Bunyakorn-K/CE-Project-2026`
- Default branch: `main`

This directory is now the application repository, not a temporary planning
workspace. Keep project documentation and implementation changes here. IRIS is
an optional read-only integration for the current LaundryTwin implementation; do
not redirect CE Project work to a Meepain-group repository unless the user
explicitly requests a cross-repository change.

## Product goal

Existing laundromats expose operational data through local Modbus, ESP, MQTT,
and Raspberry Pi systems. LaundryTwin aims to turn that existing data into a
multi-branch Digital Twin, franchise-level business intelligence, safe
AI-assisted analysis, and event-driven notifications.

Target users are commercial laundromat franchise owners, branch managers, and
technicians.

## Sources of truth

Read the relevant project documents before changing code:

- `docs/01_requirements/`: requirements, user stories, functions, priorities,
  and acceptance criteria.
- `docs/02_architecture/`: target data relationships and activity flows. Update
  the diagrams when entity ownership, process decisions, or failure paths change.
- `docs/03_data_contracts/`: telemetry fields, register maps, units, validation,
  and unresolved semantics. Read this before changing schemas, MQTT parsing,
  KPIs, alerts, or API contracts.
- `docs/04_traceability/RTM_matrix.md`: requirement-to-function traceability.
- `docs/integration/iris-laundrytwin-read-api.md`: current optional IRIS read-only
  integration. It does not override the CE requirements or data contracts.
- `docs/06_ml/ml-training-data-guide.md`: ML feature engineering schema,
  training data pipeline, and model training plan (Phase 2).
- `docs/02_architecture/deploy-runbook.md`: deployment topology, service
  configuration, and operational verification.
- `docs/07_handoffs/2026-09-30-handoff-priorities.md`: **start here to pick
  work up.** The ranked list of what is left, with the evidence record named per
  item. It supersedes `2026-09-30-next-session-plan.md`, whose "unpushed at
  `7409f5f`" and "restarts unexplained" claims are both now wrong.
- `docs/README.md`: the **documentation map.** It indexes every document and
  states which file is the single source of truth for each fact that changes.
  Consult it before searching `docs/` — a fact restated in N places is a
  duplication bug, and the map says where the one copy belongs.
- `apps/web/PRODUCT.md`: web product users, workflows, constraints, and
  Thai-first product principles.

Historical plans under `docs/superpowers/` are implementation evidence, not
current product authority.

## Phase 2 status

| Item | Status | Evidence |
|------|--------|----------|
| Weather context (F-12 label; see RTM ambiguity note) | Done (2026-09-10) | `apps/etl/src/weather.ts`, `fact_weather_sample` |
| ML off-peak baseline (#35) | Done (2026-09-14) | `get_off_peak_windows` MCP tool |
| ML training data guide | Added (2026-09-22) | `docs/06_ml/ml-training-data-guide.md` |
| Superset bootstrap (#42) | Done (2026-09-13) | `deploy/analytics/bootstrap-superset.sh` |
| Airflow Postgres (#42) | Done (2026-09-13) | `docs/04_traceability/ops-verification-2026-09-13-airflow-superset.md` |

Data volume is **~8,000 non-synthetic usage rows over ~70 calendar days**, which
is still short of the ≥ 3 months (90 days) needed for Prophet/SARIMA/GBM
candidates — sufficient for the percentile baseline only. **The exact row
count, its measurement date, and the day-coverage gaps are stated in one place
only: `docs/06_ml/ml-training-data-guide.md` §5 and §9.1. Do not restate the
number here.** It moves as the ETL ingests the IRIS backlog and as recovery
merges land, so any figure quoted without a measurement date is stale. One gap
day is a genuine source gap, not an artefact — a missing day in a training
series is a discontinuity, not a zero.

The 2026-09-30 recovery merge closed a 17-day hole (2026-08-31 → 2026-09-16)
the live warehouse was missing — see
`docs/04_traceability/ops-verification-2026-09-30-warehouse-data-recovery.md`.
That document records the root cause as **resolved**: no data was deleted.
The live volume was rolled back to a 2026-08-31 snapshot on 2026-09-17 after a
correct backup taken 15 minutes earlier was deleted 8 seconds before the restore
began. The 17 days were orphaned, not destroyed, and the original volume still
holds them. Two earlier claims in that record were wrong and are corrected
there: the two volumes share the same Atomic table UUID (a `tar -x` copy, not a
fresh init), and part *names* differ legitimately with merge boundaries, so
comparing part names is not comparing lineage. **Before any future restore,
backup, volume swap, or host migration, read that record §1 — in particular the
two still-missing restore-time guards: a restore-source freshness assertion and
a post-restore `max(extracted_at)` continuity check before the compose switch.**
The *detection* half is closed: `check_usage_continuity` in
`deploy/analytics/dags/laundrytwin_warehouse_freshness.py` now runs first in the
freshness DAG and reports day-shaped holes in `toDate(started_at)`, the business
day, so a fresh-but-holey warehouse can no longer read as healthy. It warns
rather than fails, and exempts only the evidence-backed `2026-07-27` source gap.

**This warehouse has no automated backup** — no cron, timer, or
`system.backup_schedule`; every backup was taken by hand before a specific
change, and roughly the first two months of temperature history cannot be
reloaded from IRIS. See
`docs/07_handoffs/2026-09-30-handoff-priorities.md`.

## Current production caveats

As of 2026-09-25, direct ClickHouse Dashboard and Digital Twin routes have
local automated evidence for server-side branch scope, zero-grant denial,
strict calendar date validation, bind-parameter queries, nullable revenue
redaction, active-inventory retention, usage-derived freshness, and unknown
state preservation. The cycle KPI is the paid/finished **row** count
(`countIf(status IN ('paid', 'finished'))`) — the canonical definition decided
2026-09-29 from a real-warehouse cardinality measurement, recorded in
`docs/04_traceability/RTM_matrix.md`. `status` is now numbered by the IRIS
lifecycle order (decided 2026-09-29); filter it by name, never by number.
**The production migration HAS been run** (2026-09-29, via
`apps/api/scripts/migrate-usage-status-enum.ts --apply`): `fact_machine_usage.status`
is `pending_payment=1, paid=2, admitted=3, running=4, finished=5, cancelled=6`,
and `DESCRIBE TABLE fact_machine_usage` now matches `apps/etl/src/schema.ts`.
Do not re-run it; the script refuses an already-migrated column by design. The
`proj_by_time` projection must be dropped for the swap and rebuilt after it, and
the ETL must be held still for the window — see
`deploy/etl/hold-etl-for-warehouse-migration.sh`. Because **the majority of
real usage rows carry no `machine_session_id`** (currently ~68%; the exact
figure is a live metric recorded in `docs/06_ml/ml-training-data-guide.md` §9.1
— it rises as the ETL ingests the IRIS backlog and as recovery merges land, so
never quote a stale number), the dashboard response carries `cycleAttribution`
and the web dashboard states the unattributed share in Thai; **a cycle count
must never be presented as fully attributed.** This is
code/test evidence, not production E2E. The LINE
authentication flow is not yet verified end to end — **a live sign-in needs a
real LINE account and consent, which no automated check here can perform.** What
*is* verified (2026-10-01, in a real browser against production) is the failure
path: LIFF reports a stale session as a healthy one — `isLoggedIn()` true and
`getIDToken()` returning a token nine hours past its 60-minute life, twice in a
row — so the expiry is invisible client-side and only the API rejects it. The
browser now reads the `exp` claim itself, offers a re-login instead of a retry
that cannot succeed, and the API answers **401** for a rejected token instead of
the 502 that made a stale browser look like a server outage. See
`apps/web/src/liff.ts` and `apps/api/src/liff-auth.ts`. Better Auth requires
`BETTER_AUTH_SECRET` outside test, disables public signup, and enables bounded
rate limits. Development access requires both `NODE_ENV=development` and
`LAUNDRYTWIN_DEV_BYPASS=true`; it uses an in-memory `Development Owner`, reads
configured real analytics sources, and is not a production security design.
Explicit demo mode requires a demo session cookie and remains preview-only.
MCP requires `MCP_ACCESS_TOKEN`; `MCP_ALLOW_REVENUE` is explicit false by
default. `fact_machine_event` exists but holds 0 rows (measured on the VM
2026-10-01), so Digital Twin state is derived from usage data rather than live
telemetry, and `/api/report/events` reports `availability: "unavailable"` with
a reason rather than an empty event list — an empty array would read as "no
events in this window", which is a claim the warehouse cannot support. Absent
(no such table, as with the alert source), present-but-unwritten, and
present-with-data are three states and must never render the same.

## Strict physical and safety boundaries

- Do not propose hardware modifications, new sensors, or rewiring unless the
  user explicitly changes the project scope.
- Derive machine behavior only from verified existing registers and MQTT data.
  Do not invent register meanings or silently infer unknown states.
- Pressure trends may support a low-gas estimate when evaluated with machine
  state and temperature. Do not claim that pressure alone detects a gas leak.
- Dedicated life-safety detection and local alarms are outside the current
  software-only scope. Never represent a cloud estimate as a safety system.
- Treat `paid` semantics, coin-box reset behavior, unknown registers, units,
  and model-specific mappings as unresolved until verified by evidence.

## Target MVP pillars

1. Multi-branch tenancy with server-enforced branch isolation and RBAC.
2. A context-aware Digital Twin showing verified machine state, remaining
   time, and temperature.
3. Traceable revenue, cycle, utilization, and alert analytics.
4. An Executive Assistant that calls allow-listed analytics functions and
   never executes arbitrary model-generated SQL.
5. Idempotent LINE Messaging API alerts with cooldowns and audit history.

## Current implementation

```text
apps/api/   Hono API, Better Auth, local SQLite, RBAC, direct ClickHouse reports, MCP, LINE bot, AI console
apps/web/   React/Vite mobile web and LINE LIFF interface
apps/etl/   Batch ETL: IRIS Postgres -> ClickHouse (usage/temperature/weather) + TMD weather collector
deploy/     Docker and Nginx deployment files (analytics compose: ClickHouse, Superset, Airflow, Postgres, Redis)
```

Deployment scope: LaundryTwin has two deployment tiers — local (env files plus
the `dev` run mode) and production on the existing VM
(`docs/02_architecture/deploy-runbook.md`). `dev` is a local run mode
(`pnpm dev`, `NODE_ENV=development` + `LAUNDRYTWIN_DEV_BYPASS=true`), not a
deployed environment. There is no staging environment, and no staging rollout
should be planned or described as pending work.

The current LaundryTwin paths are:

```text
LINE LIFF/browser -> React web -> Hono API + SQLite -> optional IRIS read API
                                      |
                                      +-> direct ClickHouse dashboard and Digital Twin
                                      |
                                      v
                              ClickHouse analytics warehouse
                              (fact_machine_usage, fact_weather_sample,
                               fact_temperature_sample, fact_gas_pressure_sample,
                               dim_branch_location)
                                      |
                                      v
                              allow-listed MCP analytics tools
```

The direct ClickHouse report endpoints have local code/test evidence for
server-side branch scope, zero-grant denial, strict calendar ranges, bound
ClickHouse parameters, nullable revenue redaction, active-inventory retention,
usage-derived freshness, and unknown-state preservation. Treat that as local
verification only; production, LINE, and browser E2E are still pending.

The weather collector (`laundrytwin-weather-1` on VM 117) runs
hourly (`sleep 3600`). It fetches TMD NWP forecasts and inserts
into `fact_weather_sample` tagged by `tenant_id/branch_id`.
Location targets come from `dim_branch_location` JOIN `dim_branch active=1`.
Location schema includes province, sub_district, district (currently NULL).

A **gas-pressure** collector for the `otterimju2` site is **deployed** (2026-09-30)
and runs hourly as `laundrytwin-gas-1` on VM 117, behind `profiles: ["gas"]`
(`apps/etl/src/gas.ts`, `apps/etl/src/gas-run.ts`, Docker target `gas`, compose
service `gas`). It loads three Home Assistant channels into
`fact_gas_pressure_sample`. Evidence: 26 unit tests, the DDL and its idempotency
executed on a real ClickHouse engine, a replay of the real 50,567-row export
with zero rows dropped, and the production record in
`docs/04_traceability/ops-verification-2026-09-30-gas-collector-deploy.md`
(884 rows on the first pass, 0 coerced zeros, 3 distinct `entity_id`, none of
them a `gas_detector`; an overlapping re-read merged back to the distinct set).
`value_psi` is nullable and `unavailable` is stored as NULL, never 0 (the
observed minimum is 9 psi). The `gas_detector_*` entities are **deliberately
excluded** — they are a liveness heartbeat, not a leak detector. This source is
additive and separate from usage; nothing in the Digital Twin or the
cycle/revenue KPIs derives from it, and no alert is raised from it. Full
contract and the safety boundary:
`docs/03_data_contracts/ha_gas_sensor_contract.md`.

**Any new table in this warehouse needs a grant step that the code cannot
perform.** The DDL is applied by `etl_writer` itself, so creating a table grants
that user nothing on it, and the failure only appears at the first INSERT as
`Code: 497 … Not enough privileges`. Every new fact table needs:

```sql
GRANT INSERT, CREATE TABLE ON laundrytwin_analytics.<table> TO etl_writer;
```

`SELECT` is deliberately not granted to `etl_writer` on fact tables — no fact
table grants it, and the collectors never read what they write.

The ML baseline (`get_off_peak_windows`) uses a percentile heuristic
over `fact_machine_usage`. The complete feature engineering guide for
training models is in `docs/06_ml/ml-training-data-guide.md`.

The browser must never receive upstream service credentials. Development mode
uses a local owner bypass for browser access only, requires both
`NODE_ENV=development` and `LAUNDRYTWIN_DEV_BYPASS=true`, and reads configured
real analytics sources; it must never be enabled in production. Demo mode
requires an explicit demo session cookie, remains visibly labeled for
non-development previews, and must never be an automatic fallback for
unavailable real data. MCP requires a service token, and revenue access is
explicitly disabled unless `MCP_ALLOW_REVENUE=true`. Machine commands, payment
writes, and telemetry ingestion are not part of the current implementation.

## Web design direction

Use a restrained commercial-operations visual system:

- Use LaundryTwin as the canonical product name.
- Use a calm navy/teal palette, white surfaces, clear borders, and restrained
  shadows. Reserve color for status and action, not decoration.
- Use a readable Thai-capable font stack, with monospace only for machine IDs,
  timestamps, and telemetry values.
- Prefer inline SVG or existing component icons over emoji for navigation and
  KPI indicators.
- Keep data source, demo mode, freshness, unknown, stale, and unavailable states
  visible in the interface.
- Keep Dashboard and Digital Twin visually related while preserving their
  distinct meanings and existing API behavior.
- Treat mobile LINE LIFF and desktop operations views as one responsive system;
  do not constrain desktop content to a phone-width shell.

## Engineering invariants

- Every tenant-scoped query is authorized on the server and constrained by
  branch assignment.
- Keep money as integer satang until presentation.
- Keep event time and receive time separate when telemetry is introduced.
- Version register maps and alert rules; preserve the evidence that triggered
  each alert.
- Alerts must be idempotent and must not spam recipients.
- Use parameterized, allow-listed analytics functions for AI features.
- Preserve missing, stale, offline, and unknown states; do not fabricate data.
- Never commit credentials, provider tokens, production databases, customer
  data, live captures, or local `.env` files.

## Change workflow

1. Fetch `origin` and verify the current `main` before starting substantive
   work. Preserve unrelated user changes in the working tree.
2. Identify the requirement, user story, function, and data contract affected.
3. State assumptions and unresolved hardware or data semantics.
4. Make the smallest change that satisfies the acceptance criteria.
5. Add or update focused tests, including tenant isolation and failure cases.
6. Run the narrow test first, then the repository verification commands.
7. Update the RTM or source document when approved scope changes.
8. Commit only reviewed files. Pushing code does not authorize deployment,
   production migration, or live machine actions.

Do not create a speculative parallel `src/` tree. Extend `apps/api` and
`apps/web` unless an approved architecture change establishes a new package.

## Verification

Use Node.js 24.x (see `.nvmrc`) and pnpm 10.33.4.

Local automated evidence on **2026-10-01: 547 tests green** — API 351, web 109,
ETL 87. **This is the only place the count is recorded; `README.md` points here
rather than repeating it.** The API figure rose from 320 to 351 on 2026-10-01
with tests for the four report routes that answered 503 in production, and web
from 92 to 109 with the Thai freshness and alert-source states, and with the
stale-LIFF-session handling (a browser holding an expired ID token, which LIFF
reports as a healthy session and never refreshes). Older figures
(413/384/227, then 493, then 499) were superseded, and web briefly fell to 1
after the dead-code deletion removed `dashboard-metrics.test.ts`. The separate
Playwright suite is 20 tests
and is **not** part of `pnpm test`; `layout.pw.ts` measures the shell, while
`analytics.pw.ts` and `dashboard.pw.ts` assert rendered honesty labels — that a
weather window never reads "ข้อมูลจริง", that a missing temperature is "ไม่ทราบ",
and that the executive summary is hidden over an empty window and states when
its source is unavailable. Node 24.x is used (see `.nvmrc`); no
`package.json` declares `engines` and the Dockerfiles build from the floating
`node:24-bookworm-slim` tag, so nothing local enforces a narrower Node version.
`pnpm --filter @laundrytwin/api check`, web check/test/build, and ETL test pass.
Manual browser QA of the active router was performed on 2026-09-28; it remains
manual, Chromium-only, and leaves no committed visual baseline. This does not
establish production, LINE, or browser E2E.

```bash
pnpm test
pnpm check
pnpm build
```

### Browser layout regression suite

`pnpm test` is vitest only. Responsive layout has a separate Playwright suite,
because booting a dev server is not fast or hermetic enough to sit in that
chain:

```bash
pnpm --filter @laundrytwin/web exec playwright install chromium  # once
pnpm --filter @laundrytwin/web test:layout
```

It builds `apps/web`, serves the real production bundle with
`vite preview` (default port 4319, override with `LAYOUT_TEST_PORT`), and
answers `/api/*` from fixtures via Playwright request interception. It needs
**no API process, no ClickHouse, and no SQLite**. It protects the topbar
collapse breakpoint, horizontal overflow, topbar height, sign-out
reachability, page-header typography, and the grants card/table breakpoint.

Specs are named `*.pw.ts` so vitest's default glob cannot collect them. If a
layout change is deliberate, re-measure and update the boundaries in
`e2e/support/viewports.ts` and the comment above
`@media (max-width: 1173px)` in `apps/web/src/styles.css` together. That
breakpoint is a font-metric measurement, so it is only stable because the body
font is vendored: `apps/web/public/fonts/` ships a subsetted Noto Sans Thai
woff2 that `styles.css` declares with `@font-face`. Never derive the threshold
from the host's installed fonts, and never install a system font to try to match
it — provenance, subset command and coverage notes are in
`apps/web/public/fonts/README.md`.

### Secret scanning (git hooks)

`core.hooksPath` is set to `.githooks/` (enable on a fresh clone with
`git config core.hooksPath .githooks`). pre-commit runs
`gitleaks protect --staged --redact`; pre-push scans the pushed history range.
Both require the `gitleaks` binary (brew install gitleaks). Documented false
positives go in `.gitleaks.toml` with a reason; bypassing with `--no-verify`
is discouraged and must never be used to commit a real secret.

Review `git diff --check`, ignored runtime data, and staged secret scanning
before committing. Deployment, production migration, or live machine actions
require an explicit user request, a rollback target, and a post-change smoke
test.
