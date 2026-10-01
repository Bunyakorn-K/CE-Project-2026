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

**The app SQLite is in WAL mode, so a file copy is not a backup.**
`/opt/laundrytwin/data/laundrytwin.sqlite` is a 4 KB stub; the real ~192 KB
lives in `laundrytwin.sqlite-wal`. `cp`-ing the main file succeeds, produces a
plausible file, and captures no rows. Take backups through the online API
(`await db.backup(...)` — promise-based in the installed `better-sqlite3`) and
verify with `integrity_check` plus a table and row count before relying on one.
A copy-sized backup is a failed backup, not a small one.

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
code/test evidence, not production E2E.

**The machine-state contract is three-valued and deployed** (2026-10-01,
`deploy-cbe7243-20261001`, API and web together because the web reads fields the
API change introduces). A machine's `cycleCount` is `null` with
`cycleCountSource: "unavailable"` when it has no usage rows in the window,
`"usage_row"` when it does — in which case a real `0` is a real `0` — and
`"unknown"` from the demo/IRIS path, which never measured usage rows at all and
must not claim they are absent. An earlier version inferred the state from the
session evidence alone, so a machine with 153 usage rows and no paid ones
reported "no usage rows"; the SQL now selects the denominator separately as
`countIf(u.status IS NOT NULL) AS usage_rows` (not `count()`, because
`join_use_nulls = 1` suppresses the LEFT JOIN placeholder). Verified by running
the shipped query against production ClickHouse 26.3.26: over the full history
every active machine is `counted`, but in the known `2026-07-27` source gap all
19 are `no_rows` — the exact case the old code mislabelled. **Authenticated
report rendering in a browser is still unverified**; the route scope, the SQL,
and the auth boundary are. See `docs/03_data_contracts/data_contracts.md` and
the deploy record in `docs/02_architecture/deploy-runbook.md`.

**The LINE authentication flow is now verified end to end** (2026-10-01): the
owner signed in with LINE in the real client against production and reached the
dashboard (`deploy-155e111-20261001`). That exercises the `exchange` plan — a
live token traded for a session cookie — which is the ordinary path and was the
one a regression had made unreachable. The `renew` plan (an expired token
forcing `logout()` and a fresh login) is covered by unit tests only; it was not
reproduced live, because waiting out a real token expiry was not part of the
check. The failure path is also verified: LIFF reports a stale session as a
healthy one — `isLoggedIn()` true and `getIDToken()` returning a token nine
hours past its 60-minute life, twice in a row — so the expiry is invisible
client-side and only the API rejects it. The browser now reads the `exp` claim
itself, offers a re-login instead of a retry that cannot succeed, and the API
answers **401** for a rejected token instead of the 502 that made a stale browser
look like a server outage. Sign-in is one
shared path, `signInWithLiff`, behind the pure decision `planLineSignIn` —
an earlier version logged out **any** logged-in session and therefore could
not sign anyone in. See `apps/web/src/liff.ts` and
`apps/api/src/liff-auth.ts`.

**The stale-session path was itself a defect, found in production by browser
inspection on 2026-10-01 and fixed the same day.** The gate treated an expired
cached ID token as a reason to block the whole app, which produced two
outcomes, both observed on `https://laundrytwin.duckdns.org` while
`/api/me` answered **200** with an owner grant: `/dashboard` rendered nothing
but "เซสชัน LINE หมดอายุแล้ว" to a browser that was already authenticated, and
`/login` rendered that same card **instead of** the sign-in page, hiding the
email form, the demo button and the legal links. The rule now: an ID token is
what *creates* a session, so once `/api/me` says one exists, an expired copy in
the browser is not evidence about it — the gate asks the API and renders the
route. `/login` is ungated for the same reason `/privacy` and `/terms` are, and
because it *is* the sign-in surface. Two further consequences: the gate sits
above `RouterProvider`, so while it blocks, `_authenticated`'s redirect to
`/login` never runs — a sessionless visitor was stranded on `/dashboard` — and
the card now carries an "เข้าสู่ระบบด้วยอีเมลแทน" link as the way out, alongside
the LINE re-login that remains the right action when LINE is the problem. The
card body is Thai copy keyed on the failing phase, because `initLiff` surfaces
the SDK's raw failure and a network drop was reaching the page as the English
string "Failed to fetch". Evidence: `decideGate` in
`apps/web/src/lib/components/liff-gate.tsx` with `liff-gate.test.ts` for each
state, and `apps/web/e2e/stale-liff-session.pw.ts` against the built bundle.
**A real expired token still has not been reproduced** — the LIFF SDK discards a
seeded localStorage store because it validates the cached access token against
LINE's servers first, so those specs drive the gate into the same blocking
state by making LINE unreachable instead, and the exact stale-token cause stays
unexercised. The fix is code- and browser-verified; the production symptom it
answers was measured, and re-measuring after the deploy is what confirms it.

Better Auth requires
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

**As of 2026-10-01 production runs `deploy-0ffb7ff-20261001` for the API and
`deploy-84da0f1-20261001` for the web** (record and rollback refs in
`docs/02_architecture/deploy-runbook.md`). The API deploy removed the twin's
machine illustration and made a caller's malformed `cursor` a 400 instead of a
502 source outage; the web deploy is the LIFF-gate session-probe fix below.
Every status matched its pre-deploy baseline exactly and the shipped bundles
were grepped for the changes themselves. **Authenticated report rendering in a
browser is now verified** — the dashboard renders in production with a real
owner session, which closes the longest-standing local-only caveat — while the
new Thai error copy is verified as shipped bytes and as rendered output on the
sign-in page, and the 400 for a bad cursor still has no live request behind it,
because `fact_machine_event` holds 0 rows.

**A blocked page must never be the only page, and an expired ID token is not a
statement about the session.** The LIFF gate ran above `RouterProvider` and
decided from the SDK's own state whether to render, so it could replace the
entire product — including `/login` itself — with a card offering only "sign in
with LINE again". Measured on production 2026-10-01: `/api/me` answered **200**
with an owner grant while `/dashboard` showed nothing but
"เซสชัน LINE หมดอายุแล้ว", and `/login` showed the same card instead of the
email form. Every authenticated route was broken for real users. The SDK keeps a
token past its 60-minute life and still reports `isLoggedIn() === true`, so the
expiry is invisible client-side. The rule now encoded in `decideGate`: an ID
token **creates** a session, so once `/api/me` says one exists, a stale copy
cached in the browser says nothing about it — a gate that blocks on it locks a
signed-in owner out of the product on a value the server never re-checked.
`/login`, `/privacy`, and `/terms` are ungated, the card carries an email
sign-in escape, and the card's failure copy is Thai rather than the SDK's
English. Deployed as `deploy-84da0f1-20261001` and confirmed in the very
browser that had the defect: `/dashboard` and `/login` both render, `/api/me`
200, no card. Still unverified: the `renew` plan (expired token forcing
`logout()`) is unit-tested only, and the LIFF store is SDK-encrypted so the
cached token's `exp` could not be read back as independent proof.

**A caller-supplied error must be attributed to the caller, not to the source.**
The events route answered **502 `REPORTING_SOURCE_FAILED`** for a malformed
`cursor`, because `parseEventCursor` threw a bare `Error("INVALID_CURSOR")` that
fell through `irisError`'s source-failure branch. A typo in a query string
therefore read as "the reporting warehouse is down" — the one status that sends
an operator to page someone. It is now a typed `InvalidCursorError` mapped to
**400 `INVALID_CURSOR`** before any source branch, and the route's ClickHouse
executor is asserted un-called, because the request must be rejected before it
becomes a query. This is the general rule: `irisError` is the single funnel for
every report route, so a new failure mode must either carry a typed error it can
be distinguished by or answer a status that names who can fix it. A bare
`throw new Error("CODE")` always lands in the catch-all and will be reported as
an outage.

**Every error code the API can send to a browser must have Thai copy.** The
web maps codes through `apps/web/src/lib/api-errors.ts` and falls back to a
neutral generic sentence for anything unmapped, which silently swallowed real
distinctions: a technician whose role cannot see revenue read "ไม่สามารถโหลดข้อมูลได้"
(load failed) rather than a permanent permission denial, and an unreachable
analytics warehouse read as a generic failure. `REVENUE_FORBIDDEN`,
`LAST_OWNER`, `ANALYTICS_SOURCE_UNAVAILABLE` and `INVALID_INPUT` now have their
own copy. **`api-errors.test.ts` reads the API sources and fails on any emitted
code that is neither mapped nor explicitly exempted** (`INVALID_SCOPE` and
`SCOPE_MISMATCH`, the MCP service-token path, where no browser is in the
request), so the two vocabularies cannot drift apart silently again. The test
also asserts it found the codes at all, so the scan cannot pass vacuously.

**One source owns each freshness string.** `usageFreshnessOf` and
`usageFreshnessReasonOf` are both exported and both used by every source that
builds `MachineInfo`. `demoFreshnessFields` in `apps/api/src/index.ts`
previously restated the two reason strings, which is how the demo twin and the
ClickHouse twin could disagree about the same machine — the exact hazard the
original extraction was meant to remove. The web does not render
`freshnessReason` (it keys on `freshness`), so this was a contract-duplication
risk rather than a visible-prose defect; it is fixed anyway because two copies
of one contract is the failure mode, not the current symptom.

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
deploy/     Docker deployment files (analytics compose: ClickHouse, Superset, Airflow, Postgres, Redis)
```

**The API and the web are ONE image and ONE container.** `laundrytwin:`
(built from `apps/api/Dockerfile`) serves the JSON API and the built SPA from
a single process on a single port, `8787`. `apps/web/Dockerfile` and
`deploy/nginx.conf` were deleted on 2026-10-01; there is no nginx layer and no
second service. Both hostnames reverse-proxy to `127.0.0.1:8787`.

The reason is that the two halves were never independently releasable. The
runbook already recorded deploying them as a pair — "API and web together
because the web reads fields the API change introduces" — so two image tags
with two independent rollout inputs described a coupling the release process
did not have, and nothing stopped a `web`-only rollout against a changed API
contract. One image makes the constraint structural rather than documentary.

The SPA is served by `apps/api/src/spa.ts`, which refuses to answer five path
classes, and each refusal is a tested rule rather than a comment:

1. **A server prefix is never the SPA's.** `/api`, `/webhooks`, `/mcp`,
   `/docs`, `/health`. A mistyped API route must stay a 404, because the web
   maps error codes through `api-errors.ts` and a 200 HTML body surfaces as a
   parse failure with no code to map — the same "caller error reported as
   something else" class as the 502-for-a-bad-cursor defect.
2. **A non-GET is never the SPA's.** A POST to an unknown path is a wrong URL,
   and 200-with-HTML would let a LINE webhook retry loop read as delivered.
3. **A path may not escape the web root.** This handler reads the filesystem, so
   the traversal rule is load-bearing. Note that the URL parser collapses `..`
   *before* routing, so `/../../etc/passwd` arrives as `/etc/passwd`; the one
   traversal form that survives encoded (`%2e%2e%2f`) is what the guard is for.
4. **Every served file carries its own content type.** `c.body()` does not
   infer a MIME type — it defaults to `text/plain`, which serves correct HTML
   that a browser *displays as source text* instead of rendering. This was a
   live defect on 2026-10-01, caught by the first smoke of the merged
   container, not by a status code. An unlisted extension falls back to
   `application/octet-stream`, which downloads rather than executes.
5. **"Is this a file?" is answered by the content-type map, not a regex.**
   The original `/\.[a-z0-9]{2,5}$/` matched every extension a Vite build emits
   and silently missed `.webmanifest` (11 chars), so a request for a missing
   manifest was routed to the SPA and answered **200 with HTML** — a missing
   file wearing the one status indistinguishable from success. Two facts about
   one set of extensions, expressed twice, is the failure mode.

`index.html` is served `no-cache` and hashed assets
`max-age=31536000, immutable`, because a cached shell survives a deploy and
references files that no longer exist — a blank page with no error.

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
usage-derived freshness, and unknown-state preservation. LINE sign-in itself is
verified end to end (see the caveat above). **The dashboard rendering these
endpoints is now verified in a production browser** — `deploy-84da0f1-20261001`
rendered the topbar, branch filter, KPIs, and both branch cards from real
ClickHouse data for a tenant-wide owner. What that check does **not** establish
is the narrower-grant path: branch scoping, zero-grant denial, and revenue
redaction are still covered by unit tests rather than by a production account
holding a single-branch `manager` or `technician` grant. Read them as
code-verified, not production-verified.

**A grant can now be given to an account that already exists** (`56e9e33`,
not deployed). Approving a pending access request was previously the *only* way
to create a grant, so anyone who signed in on their own could never be scoped
down to a single branch — the account had to arrive as a stranger first. For a
franchise, narrowing a manager to their own branch is an ordinary operation,
and the same gap is why production held no single-branch account to verify
scoping against. `POST /api/admin/grants` takes an email, a role, and a branch,
with the role/branch rule extracted into `validateGrantScope` so it and the
approve route cannot drift. A repeated role-for-branch is **409**, not a second
row, and a revoked scope can be re-granted. On the web, the payload and the
button's disabled state come from one pure function, `buildGrantRequest` in
`apps/web/src/lib/admin-grant.ts`; the failure that matters is an empty branch
resolving to tenant-wide, which would hand a manager *every* branch instead of
erroring, so that direction is tested and was verified to fail against the
widened code. **Creating such an account on production is still outstanding**,
so branch scoping remains unit-verified only.

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

Local automated evidence on **2026-10-01: 719 tests green** — API 420, web 212,
ETL 87. **This is the only place the count is recorded; `README.md` points here
rather than repeating it.** The API figure rose from 320 to 351 on 2026-10-01
with tests for the four report routes that answered 503 in production, then to
359 with the machine-state provenance fix (a `cycleCount` of zero and an
unavailable `cycleCount` are different facts, and the Digital Twin was calling
the first one "no usage rows") and the twin freshness axis, then to 360 with the
events-cursor blame test. Web rose from 92 to
114 with the Thai freshness and alert-source states, and with the
stale-LIFF-session handling (a browser holding an expired ID token, which LIFF
reports as a healthy session and never refreshes) — including the sign-in
decision that regression testing caught — then to 129 with the machine-facts
decision functions and the Thai error-code copy, then to 179 with the dashboard
working context: URL state, date presets, branch sort, and the prior-period
comparison, then to 182 with the API error-code coverage guard, then to 189 with
the LIFF gate decision, then to 198 with the admin direct-grant form, then to 212
with the live machine page's state-claim decision. The API
figure rose from 360 to 376 with the grant route and the store function behind
it, including the owner-only boundary and the duplicate refusal, then to 411
with the SPA handler the merge introduced — 33 tests, six of which were each
verified to fail against deliberately broken code — then to 420 with the same
handler run against the **real built bundle** rather than a fixture tree.

**A fixture tree can only contain extensions its author already thought of.**
`spa.test.ts` writes its own files, so every one of them had an extension
someone had already handled. `spa-bundle.test.ts` reads the real
`apps/web/dist` and asks whether the handler can type *every file the build
actually emitted* — and immediately found one it could not:
`/fonts/README.md`, because `apps/web/public/fonts/` is copied verbatim into
the bundle and `.md` was not in the map. That file is harmless (nothing
requests it), which is exactly why a fixture would never have surfaced it and
why "no test failed" was not the same as "this is correct". The test names the
offending file in its failure message, so the next extension a Vite plugin
introduces is a one-line fix rather than a hunt. `login.tsx` had
**no test at all** when
a broken LINE sign-in button shipped through a green suite; a UI path that can
only be exercised inside the LINE client needs its decision logic extracted as
a pure function so it can be tested without one. Older figures
(413/384/227, then 493, then 499) were superseded, and web briefly fell to 1
after the dead-code deletion removed `dashboard-metrics.test.ts`. The separate
Playwright suite is 42 tests
and is **not** part of `pnpm test`; `layout.pw.ts` measures the shell, while
`analytics.pw.ts`, `dashboard.pw.ts`, `dashboard-context.pw.ts`,
`twin-honesty.pw.ts` and `live-machine-honesty.pw.ts` assert
rendered honesty labels — that a
weather window never reads "ข้อมูลจริง", that a missing temperature is "ไม่ทราบ",
that the executive summary is hidden over an empty window and states when
its source is unavailable, and that a twin card draws no machine state its own
pills disclaim. `stale-liff-session.pw.ts` asserts that a blocking LINE gate
neither hides a route the visitor may use nor replaces the sign-in page. Node
24.x is used (see `.nvmrc`); no
`package.json` declares `engines` and the Dockerfiles build from the floating
`node:24-bookworm-slim` tag, so nothing local enforces a narrower Node version.
`pnpm --filter @laundrytwin/api check`, web check/test/build, and ETL test pass.
Manual browser QA of the active router was performed on 2026-09-28 and the
LIFF-gate change on 2026-10-01, both in Chromium against a local build; they
remain manual, Chromium-only, and leave no committed visual baseline. This does
not establish production, LINE, or browser E2E.

**CI on `main` was red for four hours and nobody saw it, because the layout
suite's one platform-dependent assertion was the only thing failing and it was
the same assertion every time.** From 07:24 on 2026-10-01, seven consecutive
commits failed with `unexpected topbar height: 1174px: 83px, expected 72px`,
while all 675 unit tests stayed green locally. The owner header's intrinsic
width had been measured on one machine (1173.30px) and the `@media` threshold
set to clear it by **0.70px**, so the contract passed wherever it was measured
and failed everywhere else.

The header width is not one number. Measured with the same Chromium 153 and the
same self-hosted woff2 — `document.fonts` confirms `Noto Sans Thai:loaded` on
both platforms, so this was never a font-coverage or version problem:

| part | macOS | Linux amd64 | Linux arm64 |
|---|---|---|---|
| brand | 197.78 | 205.81 | 205.81 |
| nav (6 links) | 629.97 | 641.00 | 641.00 |
| account | 249.55 | 260.00 | 260.00 |
| **total** | **1173.30** | **1202.81** | **1202.81** |

Two effects. Thai glyphs measure ~19px wider on Linux for identical text in an
identical font file. And `.account-name` is capped at `max-width: 130px`, where
the fixture owner `Development Owner` renders 123.67px on macOS but hits the cap
exactly on Linux — **a cap being reached is a step, not a drift, so no sub-pixel
margin can absorb it.** That is why four successive thresholds (1019, 1041,
1171, 1173) each looked right and each broke.

The threshold is now **1240px, derived from the worst measured platform**
(1202.81) with 37.19px of margin, and the full table lives in `styles.css`
beside the `@media` block so it is not re-derived from one machine a fifth
time. Two tests keep it honest, and both were verified to fail against
deliberately broken code: one measures the real header width in the browser on
every layout run and fails **with the measured number** when the headroom drops
below 20px, and one asserts the stylesheet's threshold against
`INLINE_NAV_MIN_WIDTH` so the CSS and the test cannot drift apart — which is
exactly how 1173 outlived the measurement that justified it. This is also the
pattern to follow for any other font-metric threshold: a number in a comment is
not a contract.

**The general rule this exposed: a suite that only ever runs on one platform
cannot see a platform-dependent failure, and "it passes locally" is not evidence
for a number derived from the local machine.** The fix here was verified on
macOS, `linux/amd64` and `linux/arm64` in Playwright's own container before it
was pushed, which is cheap and available — `docker build --platform
linux/amd64` against a `mcr.microsoft.com/playwright` base reproduces the CI
measurement exactly (1202.81px, first-72px at 1203).

**Deployment is now automated in two halves, and only the first is live.**
**A test that cannot run must fail, not skip — and CI must be ordered so it
can run.** `spa-bundle.test.ts` reads the real `apps/web/dist`, which is
gitignored, so on a fresh runner it does not exist until something builds it.
`ci.yml` ran `pnpm test` **before** `pnpm build`, so the file skipped on every
CI run: a green tick that asserted nothing, discovered only because the local
suite happened to run after a build. It is the same class as the red-CI section
above — a check that silently stops running is indistinguishable from one that
passes, and both cost hours here. The fix is twofold and both halves matter:
the steps are now **Build → Test → Check**, and the file has a test that
**fails** when the bundle is absent rather than skipping, naming the fix in its
message. Verified both ways: with `dist/` removed the file reports 5 failed and
**0 skipped**; with the old order the run fails, and re-running after
`pnpm build` is green. A bare `pnpm --filter @laundrytwin/api test` on a fresh
checkout therefore fails until you build — intended, and the same trade
`turbo prune` and the Playwright suite already make.


re-running the suite on push, so a red CI run publishes nothing. It checks out
`workflow_run.head_sha` explicitly, because under that event `GITHUB_SHA` is the
default-branch head — a bare checkout would build an untested commit if `main`
moved after CI went green. It builds all three images for `linux/amd64` from the
repository root and records each published digest into the run summary, so a
rollback target is a digest rather than a tag someone has to trust.

The `deploy` job is manual-dispatch only and gated on a `production` GitHub
Environment, and it deliberately does **not** SSH, run `tofu apply`, take a
backup, or migrate — the runner has no route to the VM, and a CI-taken backup
is exactly the WAL trap (`cp` of the SQLite main file yields a plausible 4 KB
stub with zero rows). It renders the exact reviewed `tofu apply` lines and
fails rather than name a tag this run did not publish.

**As of 2026-10-01 the publish half is wired but not yet configured**, so no
image has ever been published by CI and **no deployment has been automated or
attempted.** The first real run of the chain behaved correctly: CI green
fired the workflow, all three build jobs started, and each failed at
`Log in to the internal registry` with `Username and password required`. The
registry is reachable from a hosted runner — `https://registry.laundrytwin.duckdns.org/v2/`
answers **401**, so auth is live — and all three images build `linux/amd64`
from the repo root with `VITE_LIFF_ID` correctly baked in. What is missing is
configuration only: the secrets `REGISTRY_USER`, `REGISTRY_PASSWORD` and
`VITE_LIFF_ID`, and the `production` Environment, which does not exist yet
(`gh api repos/Bunyakorn-K/CE-Project-2026/environments` returns
`total_count: 0`) — so the deploy job's approval gate is currently inert.
Until those exist, deploying remains a manual host-side step under the runbook
gate, unchanged.

**The live machine page was asserting states its own cards disclaimed, measured
in production on 2026-10-01 and fixed the same day.** `/machines` rendered
`machineStatusMeta(state)` as a coloured pill unconditionally, above a freshness
pill computed from the same card. Over the 19 machines at the real branch, **17
reported `running` or `finished` with freshness `unavailable`** — so 17 cards
showed a green `status-pill--success` `กำลังใช้งาน` pill directly above a red
`ไม่พร้อมใช้งาน` pill. The loudest element on the card asserted a live machine
state that the card itself said it had no evidence for. This is the same defect
class the twin page already fixed by deleting its machine illustration; the twin
page has carried the guard ever since, and the live page never had one. The page
also dropped `coverage.liveState` entirely, so the page whose entire subject is
machine state never said it had none.

The rule is now `liveStatusClaim` in `apps/web/src/lib/live-machine-view.ts`:
`fresh` states the state plainly, `stale` keeps it but out of the success colour
and in the past tense (`สถานะล่าสุด:`), and `unavailable` **withholds** it —
`ไม่ทราบสถานะปัจจุบัน` — while preserving the last recorded value as history
(`บันทึกล่าสุดว่า …`) so a technician is not sent to re-check a machine the card
can already answer. The branch is keyed on the **raw freshness enum, never on the
Thai label**: a copy change to `freshnessMeta` would otherwise silently invert
which case withholds a state, and the failure would be invisible — a card would
start asserting a machine's state again, in the same green. An unrecognised or
absent freshness is treated as `fresh`, because only a value this build
recognises may withhold information; the reverse default would claim the product
knows less than an older API build told it. `liveStateSource` keeps *no
coverage*, *source unavailable* and *source working* distinct, and the page
states the derived-not-live boundary **once above the grid** rather than stamping
it on 19 cards. Evidence: 14 unit tests in `live-machine-view.test.ts`, each
guard verified to fail against deliberately broken code (removing the
`unavailable` branch fails 4; removing the `stale` demotion fails 1; conflating
absent coverage with unavailable fails 1), plus `e2e/live-machine-honesty.pw.ts`
against the built bundle, which reproduced the exact production markup
(`<span class="status-pill status-pill--success">กำลังใช้งาน</span>`) when the
guard was removed. Rendered in Chromium at 390px and 1440px against the measured
production payload. **Not deployed** — production still runs the web image that
carries the defect.

**The api + web merge is verified locally and is NOT deployed.** The image
`laundrytwin:ci-cbe7243-20261001` was built for real from `apps/api/Dockerfile`
and run as a single container, and this is what it was checked against — the
method is worth repeating, because the defect it caught had a correct status
code:

- Every status the merge's own smoke names (`deploy/tofu/stacks.tf`) came back
  right: `/health` 200 JSON, `/` 200, `/playground` 200, `/api/__smoke__` 404.
  **A `/health`-only smoke passes with the entire static half missing**, which
  is the specific failure this change could introduce, so the smoke set was
  widened rather than inherited.
- The API is untouched by the fallback: `/api/me` and `/mcp` 401 unauthenticated,
  `/api/openapi.json` 200 JSON, `/docs` 200, a missing asset 404, a `POST` to an
  unknown path 404, and `%2e%2e%2f…/etc/passwd` 404.
- Then the same requests **in Chromium**: `/login` and `/privacy` render, a hard
  reload of the deep link `/privacy` boots the app (`lang="th"`, `#root` present,
  stylesheet applied, `Noto Sans Thai:loaded` from the vendored woff2), every JS
  chunk including the code-split route chunk 200, and no horizontal overflow at
  390px. Same-origin `fetch` confirms the API answers on the same origin with
  the same types.

**What is not verified: anything about production.** No image was pushed to the
registry, nothing was applied on the VM, and **the Pi Caddyfile still points at
`:8080`**, so deploying this without repointing it makes
`laundrytwin.duckdns.org` return 502. The key for the Pi is not authorized for
VM 117, so that repoint is the operator's step and it is recorded in the
runbook.

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
