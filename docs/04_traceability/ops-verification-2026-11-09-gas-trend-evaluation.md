# R06 — a gas-pressure trend decision, evaluated with state and temperature

**Date:** 2026-11-09
**Files:** `apps/api/src/gas-trend.ts`, `apps/api/src/gas-trend.test.ts`,
`apps/api/src/alert-sweep.ts`, `docs/03_data_contracts/ha_gas_sensor_contract.md` §Rule 4
**Status: built and verified against production data. NOT verified in the
product — no sweep has run with this code.**

## What changed

`evaluateGasTrend(samples, context)` is a pure function returning
`unknown` / `steady` / `declining` **with its evidence** (window, sample and
non-null counts, coverage %, NULL minutes, span, edge medians, edge rate, fitted
slope, machine state, temperature, branch open state, threshold version). The
thresholds live in one exported, versioned object
(`GAS_TREND_THRESHOLDS`, version `2026-11-09.1`); no caller carries a number.

The alert sweep evaluates all three contract channels over a 6-hour window and
pushes only alertable verdicts through the existing engine, with `ruleId`
prefixed `gas.` so cooldown keys cannot collide with IRIS rule ids.

## Verified, and how

```bash
# 2026-11-09, node v24.21.0
pnpm --filter @laundrytwin/api test        # 533 passed (29 of them gas-trend)
bash deploy/analytics/dags.test.sh          # 19 passed
```

The rules that carry R06, each with the direction that matters:

| Rule | Assertion |
|---|---|
| NULL is not 0 | an all-NULL window ⇒ `unknown`, coverage 0, `nullMinutes` counted |
| 50 % coverage ⇒ `unknown` | `coveragePct === 50` and reason names the minimum |
| missing machine state ⇒ `unknown` | `suppression === "machine_state_unknown"` |
| missing temperature ⇒ `unknown` | `suppression === "temperature_unknown"` |
| short span / few samples ⇒ `unknown` | `span_too_short`, `too_few_samples` |
| closed branch ⇒ no alert | trend kept, `alertable === false`, `suppression === "branch_closed"` |
| unknown schedule ⇒ **not** suppressed | `alertable === true` |
| one dip is not a trend | not `declining` |
| one edge outlier is not a decline | `firstEdgePsi ≈ 50` after an 8 psi spike |
| `gas_detector_*` can never alert | `channel_not_evaluable`, alert `null` |
| no leak language | title contains no `รั่ว`; the body states it is not leak detection |

Three mutations were run and each is caught by exactly one test: gate back on
the fitted slope (1 failure), edge medians replaced by raw endpoints (1),
machine-state guard removed (1), coverage guard removed (2).

## Measured against production data, without the API

The app's own reader credential (`CLICKHOUSE_USER=reader`, whose grant is
`GRANT SELECT ON laundrytwin_analytics.* TO reader` — measured with
`SHOW GRANTS FOR reader`) ran the exact query in
`apps/api/src/alert-sweep.ts#queryGasSamples` for the last 6 hours:

| Fact | Value (2026-11-09 ~07:45 UTC) |
|---|---|
| rows in the window | **1,554** |
| per channel | `changeover_filter_pressure` 796, `gas_run_b_pressure` 497, `gas_run_a_pressure` 261 |
| NULL `value_psi` | 0 |
| `gas_detector_*` rows | 0 (the collector's allow-list holds) |
| machine rows `running` | 10 |
| mean `temperature_c` | 69.09 °C |
| whole table | 259,110 rows, newest 25 min old, 3 entities, 3 channels, 459 NULL psi |

Feeding those real rows through `evaluateGasTrend` produced **`steady` for all
three channels, nothing alertable** — which is the correct answer for a window
that ends flat, and is exactly why a 0-alert sweep must report `evaluated: 3`
rather than an empty body.

**That run also corrected the decision rule.** `gas_run_a_pressure` fell from a
first-edge median of 80 psi to 68 psi over 5.3 h, but its fitted slope was only
−0.142 psi/h, so the original slope-gated rule called a real 12 psi loss
`steady`. The gate is now the edge-median rate (−2.26 psi/h for that window);
the regression slope is still published in the evidence. The fixture in the test
is that real series, downsampled every 6th sample and carrying its real
timestamps, so the case cannot regress silently.

## NOT verified

- **No production sweep.** The route is not in the deployed image, so no
  `gas:` alert has ever been claimed or sent. R06 stays open.
- **No grant step was needed and none was run**: `reader` holds
  `SELECT` on the whole database, so the gas table is readable — measured, not
  assumed.
- The branch-open lookup (`dim_branch_hours` → `resolveBranchOpenState`) is the
  existing report path and degrades to `unknown` on any failure, which
  suppresses nothing. In production today the branch trades 24/7, so `closed`
  is unreachable and the suppression branch is unit-tested only.

## Safety boundary

Nothing in this change asserts a leak. The alert's own body ends with
*"เป็นการประเมินแนวโน้มร่วมกับสถานะเครื่องและอุณหภูมิ ไม่ใช่การตรวจจับแก๊สรั่ว"*,
and `docs/03_data_contracts/ha_gas_sensor_contract.md` continues to hold
`gas_leak_detected` as a separate field from a dedicated physical detector.
