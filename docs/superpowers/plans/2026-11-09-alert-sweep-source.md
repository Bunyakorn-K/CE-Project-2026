# Plan: give the alert sweep a data source (R05/R06 are blocked on one)

**Written:** 2026-11-09, after the deploy recorded in
`docs/04_traceability/ops-verification-2026-11-09-app-deploy-and-sweep-finding.md`.
**Parent plan:** `docs/superpowers/plans/2026-11-09-requirement-closure-batch.md`,
tasks 3 (R05) and 4 (R06) — both of which stay unchecked until this is resolved.

## The blocker, measured

`performAlertSweep()` calls `createIrisReadClient().liveMachines()`. That client
throws `IrisReadUnavailableError` when `IRIS_READ_BASE_URL` or
`IRIS_LAUNDRYTWIN_READ_API_KEY` is missing, and production sets neither:

```text
$ docker inspect <app> --format '{{range .Config.Env}}…{{end}}' | grep -oE '^[A-Z_]+='
… no IRIS_READ_BASE_URL, no IRIS_LAUNDRYTWIN_READ_API_KEY
$ curl -s https://laundrytwin.duckdns.org/health
{"ok":true,"reportingConfigured":false,"demoMode":false}
$ # the DAG, scheduled every 5 minutes:
scheduled__2026-11-09T10:20:00+00:00 → failed
  HTTP 503 REPORTING_SOURCE_UNAVAILABLE "IRIS reporting is not configured for LaundryTwin"
scheduled__2026-11-09T10:25:00+00:00 → failed (same)
```

`docs/02_architecture/deploy-runbook.md` already calls
`reportingConfigured: false` "the expected baseline — the optional read-only IRIS
integration production does not configure". So this is not a regression; it is a
task that was written against a dependency production does not have.

**Scope of the consequence:** the whole alert engine, not just the new route.
`/api/admin/alerts/notify` has the same dependency and has never been able to
evaluate a rule in production either. The DAG is paused so it does not produce
288 failed runs a day while this is open.

## Decision needed (owner)

**(A) Configure the IRIS read integration.** Owner supplies
`IRIS_READ_BASE_URL` and `IRIS_LAUNDRYTWIN_READ_API_KEY` (the endpoint and the
dedicated integration key described in
`docs/integration/iris-laundrytwin-read-api.md`). Then:

1. Add both to `/opt/laundrytwin/.env` (600, root) — never through chat, never in
   git, never on an argv.
2. `docker compose up -d app` to pick them up; verify
   `/health` → `reportingConfigured: true`.
3. Unpause `laundrytwin_alert_sweep`; wait for one scheduled run; the acceptance
   for R05 (a production DAG run whose summary names its window) becomes
   reachable, and R06 rides on the same sweep.
4. **Acceptance:** one succeeded DagRun plus a task log line naming the window and
   the rule ids. **Rollback:** remove the two variables, restart, re-pause.

Cost: two values and a restart. Risk: the sweep starts writing real alerts; the
first run should be watched for rule noise before it is left on a 5-minute
schedule.

**(B) Give the sweep a warehouse-backed path.** Replace the IRIS live-state read
with the ClickHouse reader the dashboard already uses
(`apps/api/src/report/clickhouse-report.ts`), so `machine_stale` / `gas.*` rules
evaluate from `fact_machine_usage` + `fact_gas_pressure_sample` instead of a live
API.

This is **not** a small refactor and it changes what an alert *means*: the
warehouse lags by the ETL's 5-minute cycle, so "machine idle" becomes "no cycles
in the warehouse in the last N minutes", and the freshness caveat has to reach
the alert text or the alert is lying about being live. It needs its own plan with
its own measurements (per-machine lag distribution, what a NULL `started_at` does
to the rule — 631 of 13,455 usage rows have one), and it should not be invented
inside task 3.

**(C) Leave it paused and mark R05/R06 unverifiable.** Honest, and free — but
then two of the six tasks in the parent plan close as "built, tested, deployed,
cannot run here", and the plan's premise that production can evaluate alerts is
wrong on its face.

## Recommendation

**(A)** if the IRIS endpoint exists — it is two variables against a plan that
already assumes them, and it makes the alert engine real rather than theoretical.
**(B)** only if the owner says the IRIS read integration is not coming, because
clickhouse-backed alerting is a different product decision about what "stale"
means.

Nothing in this plan touches ClickHouse or Postgres destructively, so it is not
gated on the warehouse backup — but it does deploy, so it carries the same gate:
explicit request, rollback tag, `db.backup()`-taken SQLite backup, post-change
smoke.

## Non-goals

- Rewriting the alert rules. Whatever is wrong with them is a separate finding;
  they cannot be judged without a data source.
- The `gas.` rules themselves — `evaluateGasTrend()` is implemented and tested
  against real production samples (29 tests,
  `ops-verification-2026-11-09-gas-trend-evaluation.md`). It is the *sweep* that
  cannot reach it.
- Backfilling the missing temperature history; that is still IRIS-only.
