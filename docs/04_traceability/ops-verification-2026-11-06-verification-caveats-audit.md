# Verification caveats audit (2026-11-06)

Audits the `AGENTS.md` verification caveats for what is actually covered by
code/test today, what needs a production account or a real client, and what
is unreachable by construction. No code changed — this is measurement, not
a fix.

## Method

Grep + read of the test files and the API/web sources named in each caveat,
as of `main` at 2026-11-06. No browser, no production account touched.

## PRIORITY 6

### `fact_temperature_sample_pre_dedup` and other count surfaces

**Done 2026-11-06.** Full grep (`apps/api/src`, `apps/etl/src`,
`deploy/analytics`) found exactly two readers of `fact_temperature_sample`:

| Reader | Purpose | Counts rows? |
|---|---|---|
| `CURVE_SQL` (`apps/api/src/analytics/queries.ts:221`) | temperature curve | Yes — `count() OVER () AS totalCount`, `countIf(...) OVER () AS synthCount` (already measured 2026-09-30) |
| Airflow `check_temperature_freshness` (`deploy/analytics/dags/laundrytwin_warehouse_freshness.py:172`) | freshness | No — `max(extracted_at)` only |
| ETL `run.ts:300` | loader | No — INSERT only |

No other API query counts the table. Drop SQL prepared at
`deploy/analytics/drop-temperature-pre-dedup.sql` (manual run on VM;
destructive, removes the rollback target).

### ML data sufficiency

**No action needed — time resolves it.** ~71 days of usage at last
measurement (2026-09-30, `docs/06_ml/ml-training-data-guide.md` §5/§9.1)
against a ≥90-day minimum for Prophet/SARIMA/GBM candidates. Do not start
a model run before 90 days.

## Verification caveats

### Narrow-grant path (branch scoping, zero-grant denial, revenue redaction)

**Unit-only, but the unit coverage is real.** Production holds no
single-branch account, so this cannot be production-verified until one is
created (`POST /api/admin/grants` per `AGENTS.md`).

| Surface | Test file | What it proves |
|---|---|---|
| Zero-grant denial | `apps/api/src/analytics/scope.test.ts:8` | `resolveAnalyticsScope([])` → 403 `ACCESS_NOT_GRANTED` (pure decision) |
| Branch scoping | `apps/api/src/analytics/scope.test.ts:17,22,31,35` + `revenue.test.ts:90`, `temperature.test.ts:238` + `utilization.test.ts:63` | Service-side grant check, 403 `BRANCH_FORBIDDEN` before querying, auto-scope to single grant, branch-required for multi-grant |
| Revenue redaction / forbidden | `apps/api/src/analytics/revenue.test.ts:60,71` + `mcp.test.ts:176` | Technician → 403 `REVENUE_FORBIDDEN`, clickhouse **not called**; cycles endpoint available to technicians in-scope |
| MCP scope | `apps/api/src/analytics/mcp.test.ts:151,176,179` | `branch_out_of_scope` / `revenue_forbidden` at the MCP layer |

**Glyph gap:** `redactDashboardDataRevenue` (daily series) and the dashboard
`cycleAttribution` are covered in web tests, but the full
`redactDashboardDataRevenue` path against a **real technician session** has
no E2E. This needs the single-branch account creation first (production
admin action, not a code change).

### `closed` rendering

**Unreachable in production by construction; unit + Playwright coverage is
complete for what can be reached.**

- Production branch schedule is 24/7 (`open_minute=0, close_minute=1440`,
  `docs/02_architecture/deploy-runbook.md`), so `closed` requires a schedule
  that positively says the branch is shut — never happens today.
- API: 38 tests on the pure decision (`apps/api/src/report/branch-availability.test.ts`)
  + 13 on ClickHouse wiring (`clickhouse-report.test.ts`) incl. missing-table
  → `unknown` fallback.
- Web: 15 tests + `e2e/closed-branch-honesty.pw.ts` against the built bundle.
- Guards mutation-verified (dropping the web wire reproduced the exact
  production markup `<span class="status-pill status-pill--danger">ไม่พร้อมใช้งาน</span>`).

This **cannot** be production-verified without provisioning a schedule that
says the branch shuts — a deliberate ops action, not a code gap.

### LINE redirect / sign-out

**Unit + Playwright only; needs one real LINE client press.**

| Leg | Evidence | Gap |
|---|---|---|
| Post-LINE-redirect navigation (`decideAfterSignIn`) | 7 unit tests (`liff-gate.test.ts`), each guard mutation-verified ×4; 3 Playwright specs (`stale-liff-session.pw.ts`) | Defect needs `liff.login()` redirect — a desktop browser cannot perform it |
| Sign-out session revocation | 2 unit tests (`app-shell.test.ts`, content-type + `credentials` mutations); 2 Playwright specs (assert `/api/me` 401 after, not URL) | Revoking a real production cookie needs the owner's credentials |
| Stale-session gate | `decideGate` unit tests (`liff-gate.test.ts`) + Playwright (LINE unreachable) | A **real expired token** cannot be reproduced — LIFF SDK validates the cached token first and discards a seeded store; the specs use an unreachable LINE as the proxy cause |

One LINE-client press (sign-in → dashboard) + one sign-in/sign-out cycle
would close these. Not a code gap.

### CI deploy (`release.yml` / `ci.yml`)

Configured but not yet activated:

- Publish half wired (`workflow_run` → build 3 images `linux/amd64`). The
  first real run correctly failed at registry login (`Username and password
  required`) — config-only gap.
- Missing: secrets `REGISTRY_USER`, `REGISTRY_PASSWORD`, `VITE_LIFF_ID`, and
  the `production` GitHub Environment (`gh api` returns `total_count: 0`).
- The `deploy` job is manual-dispatch only by design (gated on
  `production` Environment, deliberately no SSH/backups/migrations from the
  runner).

This is GitHub-side configuration, not a repo change. The PRIORITY 1 backup
gate (`docs/02_architecture/deploy-runbook.md`) is the prerequisite before
any automated deploy touches production.

## Summary

| Caveat | Status |
|---|---|
| Temperature count surfaces | ✅ Done — no second surface exists |
| Drop `pre_dedup` | SQL ready, needs manual VM run |
| ML ≥90 days | ⏳ Waiting on elapsed time |
| Narrow-grant (production) | Needs single-branch account creation |
| `closed` rendering (production) | Unreachable — schedule is 24/7 |
| LINE redirect/sign-out (real client) | Needs one LINE-client press + one sign-out cycle |
| CI deploy | GitHub config only (secrets + `production` env) |
