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

**(D) Split the dependency — IMPLEMENTED, awaiting a deploy decision.** The gas
rules were never the IRIS-bound half: `sweepGas()` reads `fact_gas_pressure_sample`
through the ClickHouse executor and its machine context comes from
`queryGasContext(clickhouse)`, not from IRIS. The only IRIS call is the 7-day
alert list at the top of `performAlertSweep`, and it was unguarded, so one
unconfigured source took down the half that works.

Measured on production before the change (2026-11-09, 6-hour window to 09:44 UTC):

| channel | samples | avg psi | NULLs | last sample |
|---|---|---|---|---|
| `gas_run_a_pressure` | 299 | 66.1 | 4 | 09:42:44 |
| `gas_run_b_pressure` | 681 | 121.9 | 4 | 09:44:29 |
| `changeover_filter_pressure` | 1,079 | 22.6 | 4 | 09:44:39 |

So a gas evaluation against the warehouse is a real measurement today, not a
synthetic one. The change: `IrisReadUnavailableError` is tolerated and becomes
`iris: {state: "unavailable", reason: "reporting_source_unavailable"}` in the
body; every other IRIS failure still fails (a configured endpoint answering 500
must not read as "not configured"); the endpoint answers 503 only when **no**
source could be read; the DAG turns a 200-with-unread-IRIS into a WARNING line
in every run rather than a red run, because failing it would make the gas rules
unrunnable on a host where they work.

What this buys: R06 can close on a production sweep summary that names its window
and its channel set, with `iris.state: unavailable` beside it. What it does not
buy: R05 (IRIS alerts still cannot be read), and the warning line stays in every
log until (A) happens. Tests: 3 new route cases (200-with-gas, 503-when-nothing,
502-on-a-real-failure) and 1 new harness case for the DAG warning.

## Recommendation

**(D) now, then (A).** (D) is a twenty-line change behind tests, it makes a
safety-relevant rule set (gas pressure) actually run in production today, and it
is honest about the half it cannot read. (A) remains the only way to close R05,
and it costs two variables whenever the endpoint shows up — nothing in (D) has to
be undone for it.

**(A) alone** if the IRIS endpoint exists — it is two variables against a plan
that already assumes them, and it makes the alert engine real rather than
theoretical.
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
