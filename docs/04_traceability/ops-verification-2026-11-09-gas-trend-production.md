# R06 closes on a production sweep summary — and the summary is only real because production found two bugs in the code

**Date:** 2026-11-09
**Images:** `deploy-f54f4cf-20261109` → `deploy-01e89f6-20261109` →
`deploy-5cc3be9-20261109` → `deploy-1a5f728-20261109`
(the last one is what produced the evidence below)
**Status: R06 closed on the DAG log named in this record. R05 is not closed and
cannot be: no IRIS source, and no LINE messaging token either.**

## The log line, verbatim

`scheduled__2026-11-09T11:05:00+00:00`, task `sweep_alerts`, attempt 1, printed at
2026-11-09T11:05:22.040323Z by
`/opt/airflow/logs/dag_id=laundrytwin_alert_sweep/run_id=scheduled__2026-11-09T11:05:00+00:00/task_id=sweep_alerts/attempt=1.log`:

```json
{"gas": {"alertable": 1, "channels": [
  {"alertable": true, "channel": "gas_run_a_pressure", "coveragePct": 97.9, "nullMinutes": 3,
   "reason": "declining:edgeRate=-1.0651psi/h,drop=6psi,slope=-1.7834psi/h",
   "sampleCount": 193, "suppression": null, "temperatureAgeHours": 24, "trend": "declining"},
  {"alertable": false, "channel": "gas_run_b_pressure", "coveragePct": 99.2, "nullMinutes": 1,
   "reason": "not_declining:edgeRate=-0.178psi/h,drop=1psi,slope=-0.3985psi/h",
   "sampleCount": 527, "suppression": null, "temperatureAgeHours": 24, "trend": "steady"},
  {"alertable": false, "channel": "changeover_filter_pressure", "coveragePct": 99.5, "nullMinutes": 1,
   "reason": "not_declining:edgeRate=0.177psi/h,drop=-1psi,slope=-0.0724psi/h",
   "sampleCount": 843, "suppression": null, "temperatureAgeHours": 24, "trend": "steady"}],
 "evaluated": 3, "reason": null, "state": "evaluated",
 "summary": {"acknowledged": 0, "cooldown": 0, "deduplicated": 0, "failed": 1, "noRecipients": 0,
             "recipients": 1, "scanned": 1, "sent": 0},
 "window": {"from": "2026-11-09T05:05:21.916Z", "to": "2026-11-09T11:05:21.916Z"}},
 "iris": {"reason": "reporting_source_unavailable", "state": "unavailable"},
 "lineConfigured": false, "scanned": 0,
 "summary": {"acknowledged": 0, "cooldown": 0, "deduplicated": 0, "failed": 0, "noRecipients": 0,
             "recipients": 0, "scanned": 0, "sent": 0},
 "window": {"from": "2026-11-02T11:05:21.916Z", "to": "2026-11-09T11:05:21.916Z"}}
```

The window is named, the evidence is in it, and the numbers are 193/527/843
samples with 3/1/1 NULL minutes over six hours. That is what R06's acceptance asks
for, and it did not exist before today.

## Two bugs that only a production run could have found

Both were in code that had passing tests, because those tests fed a fake executor
that returns rows whatever SQL it is handed. The first production call
(2026-11-09 10:42 UTC) answered 200 with `unknown` on all three channels.

| # | Defect | Symptom | Fix |
|---|---|---|---|
| 1 | `SELECT … WHERE recorded_at …` on `fact_temperature_sample`, `countIf(status = 'running')` on `fact_machine_usage` | both queries threw; each `catch` turned any failure into `unknown`, so a broken query and an empty window produced the same word | `occurred_at`; machine state derived from an open usage row (`finished_at IS NULL AND started_at IS NOT NULL`); the catches now record `*_source_unavailable:<message>` and an empty result records `machine_no_rows` / `temperature_no_data` |
| 2 | the temperature guard required a sample **inside** the 6-hour window | the ETL ingests temperature behind `temperature_lag_hours=24` (its own run log says so), so the newest row was 24 h older than the window — every channel was `unknown` by construction, a rule that cannot fire dressed as a cautious one | context falls back to the most recent sample within a bounded 30-hour lookback, and each channel reports `temperatureAgeHours` so an alert built on a 24-hour-old ambient says so |

Both are now covered by tests that assert the SQL text and the reason strings,
which is the only way a unit test can catch a query that is never executed.

## What the verdicts mean, and what they do not

- `gas_run_a_pressure` **declining**, −1.07 psi/h edge rate with a 6 psi drop over
  six hours, temperature context 24 h old. An alert row was created:
  `iris_alert_id = gas:gas_run_a_pressure:declining:2026-11-09T11`,
  severity `warning`, title `แนวโน้มแรงดันแก๊สลดลงต่อเนื่อง`.
- **Delivery failed**, and not because of the trend: the row's `error` column
  reads `LINE_CHANNEL_ACCESS_TOKEN is not configured`, and
  `docker inspect … | awk … LINE_CHANNEL_ACCESS_TOKEN=` reports a **length of 0**.
  `lineConfigured: false` in every summary is that fact.
- **IRIS alerts were never read** (`iris.state: unavailable`), because production
  configures no `IRIS_READ_BASE_URL` — see
  `2026-11-09-alert-sweep-source.md`.
- The edge rate is what gates the alert, not the fitted slope (−1.78 here). That
  choice came from the earlier production measurement where a real 12 psi decline
  had a slope of only −0.14 psi/h; the two agree in direction today, which is
  not evidence for the rule — the rule was chosen when they disagreed.

## What is verified

- The DAG is scheduled (`*/5 * * * *`), fires on the minute, and now runs green
  because the endpoint answers 200 when the gas half evaluated.
- Two consecutive scheduled runs succeeded with the summary in the log:
  `scheduled__2026-11-09T11:00:00+00:00` and `scheduled__2026-11-09T11:05:00+00:00`
  (the 11:05 log is the one quoted above). The three runs before the fix all
  failed — `manual__2026-11-09T10:06:39`, `scheduled__…T10:20:00`, `scheduled__…T10:25:00`.
- The gas rules evaluate against production rows: coverage 97.9 / 99.2 / 99.5 %,
  NULL minutes counted rather than coerced, `gas_detector_*` excluded by the typed
  channel list.
- The alert row was written with its evidence and its failure reason; the sweep
  did not claim a send it did not make (`sent: 0, failed: 1`).

## What is not verified, and blocks which task

| Gap | Measured | Blocks |
|---|---|---|
| No IRIS read endpoint | `/health` → `reportingConfigured: false`; no `IRIS_*` env on the app | R05 (the 7-day IRIS alert list) |
| No LINE messaging token | `LINE_CHANNEL_ACCESS_TOKEN` length 0; row error says so | R05 (delivery) — the engine evaluates and records, nothing is delivered |
| Temperature is 24 h behind | ETL run log `temperature_lag_hours=24`; newest row 2026-11-08T10:52 at measurement | nothing, now that the lookback exists — but every gas verdict carries `temperatureAgeHours: 24` and a reader must see it |

**R06 is closed on the log line above; R05 is not closed, and the reason is two
missing credentials rather than missing code.**
