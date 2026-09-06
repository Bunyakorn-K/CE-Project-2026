# 🧪 Test Case Documentation (LaundroTwin)

**Document Purpose:** Maps every MVP user story (US-01..US-11) and system
function (F-*) to concrete test cases, with the automated evidence that exists
in the repository. A manual test must pass against the deployed stack before a
story is claimed complete.

**Run everything:**

```bash
# Node 22+ (repo pins 24.13.0 via .nvmrc)
pnpm test     # vitest suites (api + web + etl)
pnpm check    # tsc across all packages
pnpm build    # production builds
```

Current state (2026-09-06): 109 automated tests green
(api 84 / web 2 / etl 23), `check` and `build` pass.

---

## TC Matrix (US → Test Cases → Evidence)

### US-01 — Low-gas LINE alert (F-02, F-10) · MVP

| TC-ID | Scenario | Steps | Expected result |
| :---- | :------- | :---- | :-------------- |
| TC-01.1 | Alert sweep sends a unique message | Run `runAlertSweep` with an IRIS alert; recipient has a matching grant + LINE link | Exactly one push; `alert_notification` row `status=sent`; message contains branch/sensor/time |
| TC-01.2 | Idempotency: same alert re-fetched | Run sweep twice with the same alert id (second run outside cooldown) | `sent=1, deduplicated=1`; adapter called once; 1 row per recipient |
| TC-01.3 | Cooldown: repeat occurrence of same class | Same `branch:rule:severity`, new alert id, within `ALERT_COOLDOWN_MS` | `cooldown=1`; no push; `audit_log` `alert.skipped_cooldown` |

**Automated evidence:** `apps/api/src/alert-engine.test.ts` (14 cases:
idempotency, cooldown, branch isolation, severity roles, failed/stale retry,
acknowledged skip, evidence storage, no-recipient).

### US-02 — View machine status/remaining time/temperature (F-01) · MVP

| TC-ID | Scenario | Steps | Expected result |
| :---- | :------- | :---- | :-------------- |
| TC-02.1 | Dashboard shows verified live status | `GET /api/report/live?branchId=` as manager | Machines with `state`, `remainingSeconds`, `temperatureC`, freshness `fresh/stale/unavailable` |
| TC-02.2 | Stale/unknown data is not fabricated | Source reports missing telemetry | `null` fields preserved; freshness `stale` or `unavailable` with reason |
| TC-02.3 | Technician sees machines, not revenue | Technician requests dashboard | `redactDashboardRevenue` hides `revenueSatang` |

**Automated evidence:** `apps/api/src/reporting.test.ts` (revenue redaction);
`iris-read-client.test.ts` (envelope validation, unavailable errors).

### US-03 — Coin-box threshold alert + reset audit (F-09, F-10) · MVP

> Current implementation note: `paid` semantics, coin-box reset behavior, and
> `coinbox_open` mapping are **unresolved upstream** (see
> `docs/03_data_contracts/`). The alert channel (TC-01.x) is implemented; the
> coin-box estimator and reset path are not yet implementable with verified
> evidence.

| TC-ID | Scenario | Steps | Expected result |
| :---- | :------- | :---- | :-------------- |
| TC-03.1 | Coin-box alert routes to manager | IRIS alert tagged for coin-box threshold, branch assigned | Manager (and owner) receive push; technician does not |
| TC-03.2 | Reset requires mapped `coinbox_open` | Attempt reset without mapped event | Rejected; audit record **not** created |
| TC-03.3 | Reset audit trail | Reset via authorized path | `audit_log` entry with actor, action, target, timestamp |

**Automated evidence:** alert recipient selection in `alert-engine.test.ts`;
audit writes in `access-store.ts` (via `acknowledgeAlert`/grants — same
`writeAudit` helper).

### US-04 — Revenue/cycles/utilization by branch + time (F-08) · MVP

| TC-ID | Scenario | Steps | Expected result |
| :---- | :------- | :---- | :-------------- |
| TC-04.1 | Owner views tenant totals | `GET /api/v1/analytics/revenue` + `/utilization` | Aggregates from ClickHouse; envelope carries source + freshness |
| TC-04.2 | Manager scoped to own branch | Same call with manager grant | Response filtered to granted `branchId` |
| TC-04.3 | Traceability: totals match source window | Compare API totals vs ClickHouse query for the same window | Consistent `amount_satang` aggregates (integer satang) |

**Automated evidence:** `apps/api/src/analytics/revenue.test.ts`,
`utilization.test.ts`, `scope.test.ts` (branch scoping, 30-day default,
90-day cap, malformed/inverted range rejection), `routes.test.ts`,
`clickhouse.test.ts`.

### US-05 — Scoped Executive Summary via assistant (F-11) · MVP

| TC-ID | Scenario | Steps | Expected result |
| :---- | :------- | :---- | :-------------- |
| TC-05.1 | Assistant answers from allow-listed tools only | Ask MoM revenue question to LINE bot | Tool call routed to MCP; answer composed from tool result |
| TC-05.2 | No arbitrary SQL | Prompt attempting SQL | No SQL path exists; unsupported request response |
| TC-05.3 | MCP bearer auth | Wrong/missing bearer token | 401; correct token starts a session |
| TC-05.4 | Scope enforced per branch | Analytics tool with out-of-scope branch | 403 from `resolveAnalyticsScope` |

**Automated evidence:** `apps/api/src/bot/bot.test.ts` (identity scopes,
conversation loop, signature rejection), `analytics/mcp.test.ts` (auth),
`analytics/scope.test.ts`.

### US-06 — Off-peak promotion recommendations (R09) · **Phase 2**

| TC-ID | Scenario | Steps | Expected result |
| :---- | :------- | :---- | :-------------- |
| TC-06.1 | Recommendation specifies branch/timeframe/rules | (Phase 2 — not implemented) | Output must state branch, timeframe, metric, and rules used |

**Automated evidence:** none (out of MVP scope).

### US-07 — Public machine availability (F-13) · **Phase 2**

| TC-ID | Scenario | Steps | Expected result |
| :---- | :------- | :---- | :-------------- |
| TC-07.1 | Public endpoint excludes revenue/raw telemetry | (Phase 2 — not implemented) | Schema excludes revenue, raw MQTT, cross-branch data |

**Automated evidence:** none (out of MVP scope).

### US-08 — Technician anomaly alert with machine ID + evidence (F-10) · MVP

| TC-ID | Scenario | Steps | Expected result |
| :---- | :------- | :---- | :-------------- |
| TC-08.1 | Critical severity reaches technicians | IRIS alert `severity=critical` | `rolesForSeverity("critical")` includes technician |
| TC-08.2 | Alert carries machine ID + rule version + evidence | Inspect pushed message + row | Message includes `เครื่อง:`, title/detail; `evidence` JSON stored |
| TC-08.3 | Warning does not page technicians | `severity=warning` | Technician excluded; owner/manager receive |

**Automated evidence:** `alert-engine.test.ts` (severity role mapping,
evidence storage, branch scoping).

### US-09 — Multi-branch view under one account (R04) · MVP

| TC-ID | Scenario | Steps | Expected result |
| :---- | :------- | :---- | :-------------- |
| TC-09.1 | Owner switches branches | Owner requests multiple `branchId`s across sessions | Each response authorized tenant-wide |
| TC-09.2 | Manager with one branch auto-scopes | No `branchId` requested | Auto-scopes to the single granted branch |
| TC-09.3 | Manager with several branches must choose | No `branchId` requested | 400 `BRANCH_REQUIRED` |

**Automated evidence:** `analytics/scope.test.ts` (all five scope cases),
`access-policy.test.ts`, `reporting.test.ts`.

### US-10 — Performance targets (R01, R02) · MVP

| TC-ID | Scenario | Steps | Expected result |
| :---- | :------- | :---- | :-------------- |
| TC-10.1 | E2E dashboard latency | Superset E2E against live API (2026-09-03) | 7/7 charts 200; cold 0.7–2.5 s, warm 0.26–0.53 s per chart |
| TC-10.2 | Analytics cold start | Start API (esbuild bundle) | Compiled `dist/index.mjs` used in prod (`start` script) |

**Automated evidence:** `apps/api/src/index.test.ts` (app boots, auth
gating); deploy stack E2E recorded in hindsight bank (VM 117, 2026-09-03);
perf commits `34df5fb` (gzip) + `15138c4` (esbuild).

### US-11 — RBAC branch isolation (R04, F-06) · MVP

| TC-ID | Scenario | Steps | Expected result |
| :---- | :------- | :---- | :-------------- |
| TC-11.1 | Cross-branch API request denied | Manager of B1 requests B2 data | 403 `BRANCH_FORBIDDEN`; no data leak |
| TC-11.2 | Technician stays out of revenue | Technician requests dashboard/analytics | Revenue redacted or denied |
| TC-11.3 | Unauthenticated request denied | No session/LIFF/demo cookie | 401 `AUTHENTICATION_REQUIRED`; source not called |
| TC-11.4 | Demo mode never auto-falls back | Real IRIS unavailable + demo disabled | 503/error surfaced; demo never substitutes silently |

**Automated evidence:** `access-policy.test.ts` (technician isolated,
owner tenant-wide), `analytics/scope.test.ts` (403 out-of-grant),
`index.test.ts` (401 before source call, demo gating),
`demo-read-client.test.ts` (demo envelope only when enabled).

---

## Failure & tenant-isolation corner cases (cross-cutting)

| TC-ID | Scenario | Steps | Expected result |
| :---- | :------- | :---- | :-------------- |
| TC-F1 | IRIS read API unreachable | Dashboard/alerts while IRIS down | `IrisReadResponseError` mapped to 502/503; no partial fabricated data |
| TC-F2 | IRIS misconfigured (no env) | Any report call without base URL/key | `IrisReadUnavailableError` surfaced; demo NOT substituted |
| TC-F3 | LINE channel token absent | Alert sweep runs | Attempts recorded `status=failed` with `LINE_CHANNEL_ACCESS_TOKEN is not configured`; retried next sweep |
| TC-F4 | LINE API rejects a message | Sweep with failing adapter | Row `status=failed` + error; same alert retried next sweep (`failed` rows are reclaimable) |
| TC-F5 | Sweep crashes mid-delivery | Claim inserted, process dies | Stale `sending` row (>5 min) reclaimed on next sweep |
| TC-F6 | Invalid analytics range | `from` after `to`, malformed ISO | 400; 90-day cap enforced |
| TC-F7 | Unknown LINE webhook signature | POST without valid signature | 401; events not processed |

**Automated evidence:** `iris-read-client.test.ts` (F1–F2),
`alert-engine.test.ts` (F3–F5), `analytics/scope.test.ts` (F6),
`bot/bot.test.ts` (F7), `etl/test/` (transform/watermark/schema/run:
idempotent batch load, watermark advance after commit, null preservation).

---

## Coverage summary

| Source | Count | Notes |
| :----- | :---- | :---- |
| `apps/api/src/alert-engine.test.ts` | 14 | alert engine (new) |
| `apps/api/src/analytics/*.test.ts` | ~25 | revenue, utilization, temperature, scope, routes, clickhouse, mcp |
| `apps/api/src/access-policy.test.ts` | 2 | RBAC isolation |
| `apps/api/src/index.test.ts` | 2 | boot + auth gating |
| `apps/api/src/iris-read-client.test.ts` | + | IRIS contract + errors |
| `apps/api/src/reporting.test.ts` | + | revenue redaction |
| `apps/api/src/bot/bot.test.ts` | 9 | identity, conversation, webhook |
| `apps/etl/test/*.test.ts` | 23 | pipeline |
| `apps/web/src/dashboard-metrics.test.ts` | 2 | web formatting |

Total: **109 tests green** (`pnpm test`), `pnpm check` + `pnpm build` clean.

## Maintenance rules

- A code change that alters behavior must add/update a test here; re-run
  `pnpm test && pnpm check && pnpm build` before commit.
- Phase 2 items (US-06, US-07) keep rows marked **Phase 2** until an approved
  scope change moves them to MVP.
