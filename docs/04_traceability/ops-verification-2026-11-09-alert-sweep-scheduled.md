# R05 — the alert sweep is schedulable; it has not run in production yet

**Date:** 2026-11-09
**Commit:** the R05 route and DAG (see `git log --oneline -- deploy/analytics/dags/laundrytwin_alert_sweep.py`)
**Status: built and verified locally. R05 is NOT closed.**

R05 is "event-driven notifications with cooldowns". The engine
(`apps/api/src/alert-engine.ts`) already met the mechanics — idempotent per
(alert, recipient), cooldown per alert class, claim-then-mark, audited skips —
and its only caller was an owner pressing a button. That is the gap this change
closes on the code side, and this record states plainly how far it got.

## What changed

| File | Change |
|---|---|
| `apps/api/src/alert-sweep.ts` | one `performAlertSweep()`, the token guard, and the gas block |
| `apps/api/src/index.ts` | `POST /api/internal/alerts/sweep`; `/api/admin/alerts/notify` now calls the same function |
| `apps/api/src/alert-sweep.test.ts` | 19 tests (14 at the sweep commit, 5 with gas) |
| `deploy/analytics/dags/laundrytwin_alert_sweep.py` | `*/5 * * * *`, `max_active_runs=1`, 200-only |
| `deploy/analytics/dags.test.sh` | the DAG harness, now covering both DAGs (19 assertions) |

## Verified, and how

```bash
# repo verification, 2026-11-09 15:2x local (08:2x UTC), node v24.21.0
pnpm build && pnpm test && pnpm check
#   API 532 passed / web 303 passed / ETL 105 passed
pnpm --filter @laundrytwin/web test:layout
#   56 passed, 9 skipped (no VITE_LIFF_ID in this shell, as documented)
bash deploy/analytics/dags.test.sh
#   19 passed, 0 failed
```

Assertions that carry the requirement rather than the plumbing:

- **401 without a token, 401 with the wrong token, and 401 when
  `ALERT_SWEEP_TOKEN` is unset** — the last one is the important direction: a
  deployment that forgot the token must not become an open notification trigger.
  `IRIS.getAlerts` is asserted **not called** in all three.
- **The two routes answer the same key set.** Compared directly, not by reading
  the handlers: `Object.keys(manual).sort()` equals `Object.keys(internal).sort()`.
- **A second sweep inside the cooldown window sends nothing and reports it**:
  `summary.sent === 0`, `summary.cooldown > 0`, one `alert_notification` row (not
  two), and an `audit_log` row with `action = 'alert.skipped_cooldown'` — a
  silent non-send is still recorded.
- **The DAG fails rather than passing quietly**: a 401, an unreachable endpoint
  and a non-JSON body each raise `AirflowFailException`; a 200 prints the
  summary verbatim, including a valid `scanned: 0`.

Two mutations were run against the guards and both bite: making the token
comparison return `true` unconditionally fails 1 test; removing the route guard
fails 3.

## NOT verified — and why that is the honest state

**No production DagRun exists.** The route lives in `apps/api/src/index.ts`, and
production runs `laundrytwin:deploy-4fb470d-20261109`, which does not contain it.
Deploying is gated on the warehouse-backup prerequisite, which is still absent
(`AGENTS.md`: "This warehouse has no automated backup"), so this task stops at
"built and verified locally".

The DAG file is therefore **in the repository and deliberately not copied to
`/opt/analytics/dags/`**. A scheduler that POSTs to a 404 every five minutes
produces a permanently red DAG, which is the same class of defect as a check
that exists but never runs — except inverted: it trains people to ignore red.

R05 closes on a DAG run log whose summary names its window and its `scanned`
count. A `scanned: 0` result is a valid pass; "no alerts fired" is not the same
claim as "no alerts were found", and this record does not make the second.

## To close it

1. A gated deploy of the app image carrying `POST /api/internal/alerts/sweep`,
   with `ALERT_SWEEP_TOKEN` in `/opt/laundrytwin/.env` (value never handled
   here) and the same value stored as the Airflow Variable
   `alert_sweep_token` (`airflow variables set alert_sweep_token …` inside the
   scheduler container — the DAG reads the Variable, never prints it).
2. Copy `deploy/analytics/dags/laundrytwin_alert_sweep.py` to
   `/opt/analytics/dags/` and let one run complete.
3. Paste that run's `alert sweep summary: {…}` line into this record.
