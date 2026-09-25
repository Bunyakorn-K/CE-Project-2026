# 🧪 Test Case Documentation (LaundryTwin)

**Document Purpose:** Map MVP and Phase 2 user stories to current local test
coverage without claiming that every target function is complete. A local test
pass is not staging, LINE, browser E2E, or production evidence.

## Commands and current evidence

Repository verification uses Node.js 24.13.0 and pnpm 10.33.4.

```bash
pnpm test
pnpm check
pnpm build
```

Current local automated result (2026-09-25): **181 tests green** —
**142 API**, **2 web**, and **37 ETL**. The following focused checks also pass:

```bash
pnpm --filter @laundrytwin/api check
pnpm --filter @laundrytwin/web check
pnpm --filter @laundrytwin/web test
pnpm --filter @laundrytwin/web build
pnpm --filter @laundrytwin/etl test
```

The 181-test result is local automated evidence. Do not use it to claim staging,
LINE authentication, browser, or production E2E verification. Screenshot and
browser QA of the active web router remain pending.

## TC Matrix (US → local evidence)

### US-01 — Low-gas LINE alert (F-02, F-10) · MVP

| TC-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| TC-01.1 | Alert sweep with an eligible recipient | One push and a `sent` notification row containing branch, machine, severity, and evidence | Automated in `apps/api/src/alert-engine.test.ts` |
| TC-01.2 | Same alert re-fetched | Adapter called once; deduplication count increments | Automated |
| TC-01.3 | Repeat alert class inside cooldown | No second push; cooldown audit/skipped result | Automated |
| TC-01.4 | Technician/manager/owner recipient and branch scope | Only eligible role and granted branch receive alert | Automated |

The low-gas trend evaluator is not implemented because a verified gas-pressure
register is not available. The notification arm is tested; F-02 is partial.

### US-02 — Machine status / Digital Twin (F-01) · MVP

| TC-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| TC-02.1 | Dashboard/Twin request from an authorized principal | ClickHouse report executes within server branch scope | Automated in `apps/api/src/index.test.ts` and `report/clickhouse-report.test.ts` |
| TC-02.2 | No grants or request outside grant | `403` before ClickHouse or IRIS is called | Automated |
| TC-02.3 | Strict calendar range | Malformed, inverted, and overlong `from`/`to` return `400` before query | Automated |
| TC-02.4 | Active machine has no usage rows | Machine remains in inventory with `cycleCount: null`, source `unavailable`, and state `unknown` where evidence is missing | Automated |
| TC-02.5 | Unrecognized status or missing telemetry | Unknown/unavailable state is preserved; no value is fabricated | Automated |
| TC-02.6 | Technician dashboard | Revenue is `null`/redacted while operational counts remain available | Automated |

Current Twin state is usage-derived, not live `fact_machine_event` telemetry.
IRIS-backed live reporting and LINE browser flows still require E2E verification.

### US-03 — Coin-box alert and reset (F-09, F-10) · MVP

`paid` semantics, coin-box reset behavior, and `coinbox_open` mapping remain
unresolved upstream. The alert recipient and evidence path is tested, but the
coin-box estimator and verified reset path are not implemented.

| TC-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| TC-03.1 | Alert tagged to a granted branch | Owner/manager/technician roles follow alert severity rules | Automated alert tests |
| TC-03.2 | Unmapped reset input | No reset is inferred from door status | Not implemented; blocked by contract |
| TC-03.3 | Mapped reset and audit | Reset creates an auditable event | Not implemented; blocked by contract |

### US-04 — Revenue/cycles/utilization (F-08) · MVP

| TC-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| TC-04.1 | Owner requests Dashboard | Tenant-wide usage-derived totals and source/availability metadata | Automated in `index.test.ts` |
| TC-04.2 | Manager requests a granted branch | Query receives the granted branch as a ClickHouse bind parameter | Automated |
| TC-04.3 | Technician requests Dashboard | Revenue is nullable/redacted; cross-branch requests are denied | Automated |
| TC-04.4 | Dashboard and Twin dates | Dates are strict `YYYY-MM-DD` calendar ranges and are not interpolated into SQL | Automated in `index.test.ts`, `scope.test.ts`, `clickhouse-report.test.ts` |
| TC-04.5 | Analytics v1 routes | Session, zero-grant, branch-scope, and range gates run before ClickHouse | Automated in analytics route/scope tests |

Production dashboard and staging evidence are not claimed.

### US-05 — Scoped Executive Assistant (F-11, F-07) · MVP

| TC-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| TC-05.1 | Six current tools are listed | Names are exactly the current allow-list in RTM | Automated in `analytics/mcp.test.ts` |
| TC-05.2 | Model supplies an `accessScope` argument | Argument is absent from every tool schema; bot removes it before calling MCP | Automated in `mcp.test.ts` and `bot.test.ts` |
| TC-05.3 | LINE user asks a question | Bot derives branch and revenue scope from server-resolved grants and signs per-session scope | Automated in `bot/bot.test.ts` and `analytics/mcp.test.ts` |
| TC-05.4 | Out-of-scope branch | MCP returns branch-scope error before querying | Automated |
| TC-05.5 | MCP service token missing/wrong | `/mcp` returns `401`; correct token can initialize a session | Automated |
| TC-05.6 | Service revenue flag | `MCP_ALLOW_REVENUE=false` disables revenue tool calls by default | Automated |
| TC-05.7 | Unsupported request | No arbitrary SQL path; assistant says the request is unsupported or data is insufficient | Partial local behavior |

Current schema has audit entries for grants, alerts, and settings, but no
complete append-only prompt/tool-call/result audit table. Full F-07/F-11 audit
traceability remains partial.

### US-06 — Off-peak promotion (R09) · Phase 2 baseline

| TC-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| TC-06.1 | `get_off_peak_windows` | Percentile-ranked local-hour buckets include rules and caveats | Automated in `mcp.test.ts` and ETL/API tests |
| TC-06.2 | Model/promotion decision | Branch, timeframe, metric, and rules are stated; no price or campaign write-back is implied | Baseline only |

`get_off_peak_windows` is a current Phase 2 baseline. F-12 is formally weather
context; no new function ID is assigned to this work in the RTM.

### US-07 — Public machine availability (F-13) · Phase 2

No public availability endpoint is implemented. Revenue, raw telemetry, and
cross-branch exclusion remain target acceptance criteria, not current test
evidence.

### US-08 — Maintenance alert evidence (F-10) · MVP

| TC-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| TC-08.1 | Critical vs warning severity | Critical can reach technicians; warning does not page technicians | Automated |
| TC-08.2 | Alert evidence | Machine ID, rule/version fields, severity, timestamp, and evidence are stored in the notification row | Automated |
| TC-08.3 | Failed or stale delivery | Failed row is retryable; stale in-flight claim is reclaimed | Automated |

### US-09 — Multi-branch access (R04) · MVP

| TC-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| TC-09.1 | Owner with no branch filter | Tenant-wide scope is allowed | Automated |
| TC-09.2 | Single granted branch and no filter | Scope auto-resolves to that branch | Automated |
| TC-09.3 | Several granted branches and no filter | `400 BRANCH_REQUIRED` | Automated |
| TC-09.4 | Requested branch outside grant | `403 BRANCH_FORBIDDEN`; source is not called | Automated |

### US-10 — Performance and streaming targets (R01, R02) · MVP

Current local tests validate app boot, report boundaries, ETL schema, null
preservation, and data-path behavior. They do not establish the target p95
latency, MQTT/SSE reconnect behavior, or live browser refresh behavior. Those
requirements remain partial or unverified.

### US-11 — RBAC and data privacy (R04, F-06) · MVP

| TC-ID | Scenario | Expected result | Evidence/status |
| :--- | :--- | :--- | :--- |
| TC-11.1 | Unauthenticated request | `401 AUTHENTICATION_REQUIRED`; source is not called | Automated |
| TC-11.2 | Zero grants | `403 ACCESS_NOT_GRANTED`; source is not called | Automated |
| TC-11.3 | Cross-branch request | `403 BRANCH_FORBIDDEN`; no data leak | Automated |
| TC-11.4 | Technician revenue request | Revenue is redacted or denied | Automated |
| TC-11.5 | Better Auth configuration | `BETTER_AUTH_SECRET` required outside test; public signup disabled; rate limits enabled | Automated in `auth.test.ts` |
| TC-11.6 | Demo mode | Explicit demo session cookie is required; demo is not an automatic fallback | Automated in `index.test.ts` and `demo-read-client` tests |
| TC-11.7 | Development bypass | Requires both `NODE_ENV=development` and `LAUNDRYTWIN_DEV_BYPASS=true`; owner is in-memory and not persisted | Automated in `index.test.ts` |

## Cross-cutting failure cases

| TC-ID | Scenario | Expected result |
| :--- | :--- | :--- |
| TC-F1 | IRIS unavailable or misconfigured | `REPORTING_SOURCE_UNAVAILABLE`; no silent demo substitution |
| TC-F2 | Invalid analytics dates | `400`; range is calendar-date validated and capped at 90 days for analytics |
| TC-F3 | Missing LINE channel token | Alert delivery records failure and remains retryable |
| TC-F4 | Invalid LINE webhook signature | `401`; event is not processed |
| TC-F5 | ClickHouse unavailable | Explicit analytics source-unavailable result |
| TC-F6 | ETL source/transform failure | Watermark and null-preservation behavior are tested; no fabricated values |

## Package-level coverage summary

| Package | Count | Scope |
| :--- | ---: | :--- |
| `apps/api` | 142 | Auth, report/analytics gates, ClickHouse parameter binding/redaction/unknown state, MCP allow-list/scope/revenue flag, LINE bot, alerts, access control, and failure cases |
| `apps/web` | 2 | Local web formatting/unit coverage; active-router screenshot/browser QA is pending |
| `apps/etl` | 37 | Schema, transform, null preservation, watermark/idempotency, ETL run, and weather collection |
| **Total** | **181** | **Local automated evidence only** |

## Maintenance rules

- A behavior change must add or update focused tests, especially tenant
  isolation, date validation, revenue redaction, unknown-state preservation, and
  MCP scope boundaries.
- Re-run the focused package checks before committing; do not convert a local
  pass into a staging, LINE, browser, or production claim without evidence.
- Phase 2 rows remain partial or baseline until their target acceptance criteria
  and deployment/manual evidence exist.
