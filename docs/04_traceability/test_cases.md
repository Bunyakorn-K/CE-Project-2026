# 🧪 Test Case Documentation (LaundryTwin)

**Document Purpose:** Map MVP and Phase 2 user stories to current local test
coverage without claiming that every target function is complete. A local test
pass is not production, LINE, or browser E2E evidence.

## Commands and current evidence

Repository verification targets the Node.js 24.x line (see `.nvmrc`, which CI
reads via `node-version-file`) and pnpm 10.33.4, which is exact because
`packageManager: "pnpm@10.33.4"` is corepack-enforced. The Node range is
documented, not enforced locally: no `package.json` declares `engines`, and
`apps/api/Dockerfile` — which since 2026-10-01 builds the app, API and SPA
together — builds from the floating `node:24-bookworm-slim` tag. The
2026-09-27 run below used Node 24.21.0, within the 24.x line.

```bash
pnpm test
pnpm check
pnpm build
```

Current local automated test count is recorded in **one place only** —
[`AGENTS.md` §Verification](../AGENTS.md#verification) (**967 tests green on
2026-11-09** — API 547, web 303, ETL 117). **Do not restate the number here.**
This table is the *method*: `pnpm test`, `pnpm check`, `pnpm build` (plus the
focused package checks below). The package-level coverage summary at the bottom
of this file is indicative scope, not the current count.

```bash
pnpm --filter @laundrytwin/api check
pnpm --filter @laundrytwin/web check
pnpm --filter @laundrytwin/web test
pnpm --filter @laundrytwin/web build
pnpm --filter @laundrytwin/etl test
```

The test results above are **local automated evidence only**. Do not use them
to claim production, LINE authentication, or browser E2E verification. Manual
screenshot and browser QA of the active web router was performed on
2026-09-28 at 390/430/1440 plus a 320–1920 width sweep, against a locally
seeded ClickHouse, and found the real defects listed in the 2026-09-25
handoff; it is still manual QA with no committed visual baseline, and it
covered Chromium only.

Responsive layout additionally has a committed Playwright suite,
`apps/web/e2e/layout.pw.ts` (**11 tests**, `pnpm --filter
@laundrytwin/web test:layout`). It is deliberately **not** part of `pnpm
test` — specs are named `*.pw.ts` so vitest's glob cannot collect them — and
is not counted in the total recorded in AGENTS.md §Verification. It runs against the built bundle with a
stubbed API and needs no API process, ClickHouse, or SQLite.

## T Matrix (US → local evidence)

### US-01 — Low-gas LINE alert (F-02, F-10) · MVP

| T-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| T-01.1 | Alert sweep with an eligible recipient | One push and a `sent` notification row containing branch, machine, severity, and evidence | Automated in `apps/api/src/alert-engine.test.ts` |
| T-01.2 | Same alert re-fetched | Adapter called once; deduplication count increments | Automated |
| T-01.3 | Repeat alert class inside cooldown | No second push; cooldown audit/skipped result | Automated |
| T-01.4 | Technician/manager/owner recipient and branch scope | Only eligible role and granted branch receive alert | Automated |

The low-gas trend evaluator is not implemented because a verified gas-pressure
register is not available. The notification arm is tested; F-02 is partial.

### US-02 — Machine status / Digital Twin (F-01) · MVP

| T-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| T-02.1 | Dashboard/Twin request from an authorized principal | ClickHouse report executes within server branch scope | Automated in `apps/api/src/index.test.ts` and `report/clickhouse-report.test.ts` |
| T-02.2 | No grants or request outside grant | `403` before ClickHouse or IRIS is called | Automated |
| T-02.3 | Strict calendar range | Malformed, inverted, and overlong `from`/`to` return `400` before query | Automated |
| T-02.4 | Active machine has no usage rows | Machine remains in inventory with `cycleCount: null`, source `unavailable`, and state `unknown` where evidence is missing | Automated |
| T-02.5 | Unrecognized status or missing telemetry | Unknown/unavailable state is preserved; no value is fabricated | Automated |
| T-02.7 | Known `finished` / `cancelled` / `admitted` status | Each maps to its own API status value; `finished` stays distinct from `paid` so `paid_ratio` remains computable | Automated in `report/clickhouse-report.test.ts` |
| T-02.6 | Technician dashboard | Revenue is `null`/redacted while operational counts remain available | Automated |
| T-02.8 | Most usage rows carry no `machine_session_id` | `dashboard.cycleAttribution` reports the unattributed share and the web dashboard states it in Thai, so the cycle count is not readable as fully attributed | Automated in `report/clickhouse-report.test.ts` and `dashboard-view.test.ts`; rendered in a built-bundle browser run |

Current Twin state is usage-derived, not live `fact_machine_event` telemetry.
IRIS-backed live reporting and LINE browser flows still require E2E verification.

### US-03 — Coin-box alert and reset (F-09, F-10) · MVP

`paid` semantics, coin-box reset behavior, and `coinbox_open` mapping remain
unresolved upstream. The alert recipient and evidence path is tested, but the
coin-box estimator and verified reset path are not implemented.

| T-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| T-03.1 | Alert tagged to a granted branch | Owner/manager/technician roles follow alert severity rules | Automated alert tests |
| T-03.2 | Unmapped reset input | No reset is inferred from door status | Not implemented; blocked by contract |
| T-03.3 | Mapped reset and audit | Reset creates an auditable event | Not implemented; blocked by contract |

### US-04 — Revenue/cycles/utilization (F-08) · MVP

| T-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| T-04.1 | Owner requests Dashboard | Tenant-wide usage-derived totals and source/availability metadata | Automated in `index.test.ts` |
| T-04.2 | Manager requests a granted branch | Query receives the granted branch as a ClickHouse bind parameter | Automated |
| T-04.3 | Technician requests Dashboard | Revenue is nullable/redacted; cross-branch requests are denied | Automated |
| T-04.4 | Dashboard and Twin dates | Dates are strict `YYYY-MM-DD` calendar ranges and are not interpolated into SQL | Automated in `index.test.ts`, `scope.test.ts`, `clickhouse-report.test.ts` |
| T-04.5 | Analytics v1 routes | Session, zero-grant, branch-scope, and range gates run before ClickHouse | Automated in analytics route/scope tests |

Production dashboard evidence is not claimed.

### US-05 — Scoped Executive Assistant (F-11, F-07) · MVP

| T-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| T-05.1 | Six current tools are listed | Names are exactly the current allow-list in RTM | Automated in `analytics/mcp.test.ts` |
| T-05.2 | Model supplies an `accessScope` argument | Argument is absent from every tool schema; bot removes it before calling MCP | Automated in `mcp.test.ts` and `bot.test.ts` |
| T-05.3 | LINE user asks a question | Bot derives branch and revenue scope from server-resolved grants and signs per-session scope | Automated in `bot/bot.test.ts` and `analytics/mcp.test.ts` |
| T-05.4 | Out-of-scope branch | MCP returns branch-scope error before querying | Automated |
| T-05.5 | MCP service token missing/wrong | `/mcp` returns `401`; correct token can initialize a session | Automated |
| T-05.6 | Service revenue flag | `MCP_ALLOW_REVENUE=false` disables revenue tool calls by default | Automated |
| T-05.7 | Unsupported request | No arbitrary SQL path; assistant says the request is unsupported or data is insufficient | Partial local behavior |

Current schema has audit entries for grants, alerts, and settings, but no
complete append-only prompt/tool-call/result audit table. Full F-07/F-11 audit
traceability remains partial.

### US-06 — Off-peak promotion (R09) · Phase 2 baseline

| T-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| T-06.1 | `get_off_peak_windows` | Percentile-ranked local-hour buckets include rules and caveats | Automated in `mcp.test.ts` and ETL/API tests |
| T-06.2 | Model/promotion decision | Branch, timeframe, metric, and rules are stated; no price or campaign write-back is implied | Baseline only |

`get_off_peak_windows` is a current Phase 2 baseline. F-12 is formally weather
context; no new function ID is assigned to this work in the RTM.

### US-07 — Public machine availability (F-13) · Phase 2

No public availability endpoint is implemented. Revenue, raw telemetry, and
cross-branch exclusion remain target acceptance criteria, not current test
evidence.

### US-08 — Maintenance alert evidence (F-10) · MVP

| T-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| T-08.1 | Critical vs warning severity | Critical can reach technicians; warning does not page technicians | Automated |
| T-08.2 | Alert evidence | Machine ID, rule/version fields, severity, timestamp, and evidence are stored in the notification row | Automated |
| T-08.3 | Failed or stale delivery | Failed row is retryable; stale in-flight claim is reclaimed | Automated |

### US-09 — Multi-branch access (R04) · MVP

| T-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| T-09.1 | Owner with no branch filter | Tenant-wide scope is allowed | Automated |
| T-09.2 | Single granted branch and no filter | Scope auto-resolves to that branch | Automated |
| T-09.3 | Several granted branches and no filter | `400 BRANCH_REQUIRED` | Automated |
| T-09.4 | Requested branch outside grant | `403 BRANCH_FORBIDDEN`; source is not called | Automated |

### US-10 — Performance and streaming targets (R01, R02) · MVP

Current local tests validate app boot, report boundaries, ETL schema, null
preservation, and data-path behavior. They do not establish the target p95
latency, MQTT/SSE reconnect behavior, or live browser refresh behavior. Those
requirements remain partial or unverified.

### US-11 — RBAC and data privacy (R04, F-06) · MVP

| T-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| T-11.1 | Unauthenticated request | `401 AUTHENTICATION_REQUIRED`; source is not called | Automated |
| T-11.2 | Zero grants | `403 ACCESS_NOT_GRANTED`; source is not called | Automated |
| T-11.3 | Cross-branch request | `403 BRANCH_FORBIDDEN`; no data leak | Automated |
| T-11.4 | Technician revenue request | Revenue is redacted or denied | Automated |
| T-11.5 | Better Auth configuration | `BETTER_AUTH_SECRET` required outside test; public signup disabled; rate limits enabled | Automated in `auth.test.ts` |
| T-11.6 | Demo mode | Explicit demo session cookie is required; demo is not an automatic fallback | Automated in `index.test.ts` and `demo-read-client` tests |
| T-11.7 | Development bypass | Requires both `NODE_ENV=development` and `LAUNDRYTWIN_DEV_BYPASS=true`; owner is in-memory and not persisted | Automated in `index.test.ts` |

## Cross-cutting failure cases

| T-ID | Scenario | Expected result |
| :--- | :--- | :--- |
| T-F1 | IRIS unavailable or misconfigured | `REPORTING_SOURCE_UNAVAILABLE`; no silent demo substitution |
| T-F2 | Invalid analytics dates | `400`; range is calendar-date validated and capped at 90 days for analytics |
| T-F3 | Missing LINE channel token | Alert delivery records failure and remains retryable |
| T-F4 | Invalid LINE webhook signature | `401`; event is not processed |
| T-F5 | ClickHouse unavailable | Explicit analytics source-unavailable result |
| T-F6 | ETL source/transform failure | Watermark and null-preservation behavior are tested; no fabricated values |

## Package-level coverage summary

| Package | Coverage scope (indicative — count lives in AGENTS.md §Verification) |
| :--- | :--- |
| `apps/api` | Auth, report/analytics gates, ClickHouse parameter binding/redaction/unknown state, MCP allow-list/scope/revenue flag, LINE bot, alerts, access control, and failure cases |
| `apps/web` | Development API proxy configuration, branch scope, machine status mapping, dashboard view formatting, plus manual browser QA of the active router (2026-09-28) |
| `apps/etl` | Schema, transform, null preservation, watermark/idempotency, ETL run, ML features, and weather collection |

All rows above are **local automated evidence only** (plus the separate
Playwright layout suite outside `pnpm test`) — not production, LINE, or
browser E2E. Current totals are recorded once in
[`AGENTS.md` §Verification](../AGENTS.md#verification), not here.

## Maintenance rules

- A behavior change must add or update focused tests, especially tenant
  isolation, date validation, revenue redaction, unknown-state preservation, and
  MCP scope boundaries.
- Re-run the focused package checks before committing; do not convert a local
  pass into a production, LINE, or browser claim without evidence.
- Phase 2 rows remain partial or baseline until their target acceptance criteria
  and deployment/manual evidence exist.
