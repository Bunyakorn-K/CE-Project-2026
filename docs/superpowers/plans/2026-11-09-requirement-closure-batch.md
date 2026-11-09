# Six gaps between the shipped app and its own requirements

> **Status 2026-11-09 (evening): executed to the deploy gate, and it stopped
> there.** Tasks 2, 3, 4, 5 and 6 are built, tested and recorded; task 3's and
> task 4's production halves are **blocked on a gated deploy** (the prerequisite
> in the next sentence is still unmet), and task 1 is **blocked on the human**
> (CI secrets and the `production` environment need repository admin). One
> evidence record per task lives under `docs/04_traceability/ops-verification-2026-11-09-*`.
> Written from the audit measured against production that morning (numbers in
> "Ground truth" below, all read from the running system, not from other
> documents). Covers **items 2–7** of that audit's ranked list. Item 1 — the
> missing automated ClickHouse backup — is a **prerequisite for every deploy in
> this plan**, not a task inside it, and it is still missing.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** close the six gaps where the product either asserts something it does not
do (an alert engine nothing triggers), holds data nothing reads (259k gas samples),
or is one backend death away from a multi-minute outage — and unblock the ML work
that the 90-day gate has now released.

**Non-goals, stated so they are not quietly absorbed:** automated warehouse backup
(item 1, prerequisite), model deployment, R10 predictive maintenance, R11 public
status API, F-03 floorplan, F-04 streaming. None of those is closer after this plan.

## Ground truth, measured 2026-11-09 ~06:00Z

| Fact | Value | Where it came from |
|---|---|---|
| Usage rows / distinct days / span | 13,455 / **110** / 2026-07-22 → 2026-11-09 (re-measured 2026-11-09 07:45 UTC; it was 13,453 at 06:00) | ClickHouse `fact_machine_usage` |
| Known source gap | `2026-07-27` (110 days over a 111-day span) | same |
| `fact_machine_event` | **0 rows** | ClickHouse |
| Gas samples | **259,110**, newest 25 min old, 3 entities, 459 NULL psi (re-measured 07:45 UTC; the earlier 259,356 was not taken through `FINAL`, which dedupes ReplacingMergeTree parts) | `fact_gas_pressure_sample` |
| Temperature samples | 2,708,181, extracted 4 min ago | `fact_temperature_sample` |
| ETL lag | ~3 min (5-min cycle) | `max(extracted_at)` |
| Alert sweep triggers | **one**, `POST /api/admin/alerts/notify`, owner-only | `apps/api/src/index.ts:575` |
| Schedulers calling it | **none** (no cron, timer, DAG, compose service) | repo-wide grep |
| MCP tools | 6 | `apps/api/src/analytics/mcp.ts` |
| AI tool-call audit rows written | **0** — no `audit` write in `ai-routes.ts`/`mcp.ts` | grep |
| Postgres reinits | 61 since 2026-09-06 (39 × exit code 2, 16 × signal 13); **2** in the current container since 2026-11-06 14:51, latest **2026-11-09 04:06:26**, recovery **81 s** | compose comment + docker logs |
| `mcp-inspector` | **3420 restarts**, empty log | `docker inspect` |
| Unpushed commits | **11** (`origin/main..HEAD`) | git |
| CI publish | environments **0**, secrets **[]** | GitHub API |
| Rows without `machine_session_id` | **9,198 = 68.4 %** | `fact_machine_usage FINAL` |
| Machines in `dim_machine` (active) | **23** across 2 branches (19 at the real one) | ClickHouse |
| Disk | `/` 91 % used, **7.6 GB free** | `df -h` |

## Order, and why this order

1. **Land the work** (Task 1) — cheapest, unblocks every later rollout, and right now
   eleven commits exist only on one laptop.
2. **Postgres** (Task 2) — the only item where the failure is still *worsening*
   (recovery 20–30 s → 81 s) and unmeasured.
3. **Alerts** (Task 3) — R05 is the requirement the app most visibly fails: the
   engine is correct, nothing runs it.
4. **Gas trend** (Task 4) — depends on Task 3's sweep, since that is where the
   evaluation must fire.
5. **AI audit** (Task 5) — independent, but a data-contract decision that is cheaper
   before the AI surface grows.
6. **ML** (Task 6) — now unblocked by 110 days; needs the guide corrected first.

Tasks 3, 4 and 5 each end in a deploy. **Every deploy in this plan is gated** on:
an explicit request, a rollback image tag, a `db.backup()`-taken and verified SQLite
backup, and a post-change smoke test — and, per item 1 above, on the warehouse
backup existing first. If that gate is not met, the task stops at "built and
verified locally" and says so.

---

## Task 1 — Land eleven commits and make the publish half of CI real

**Why:** `release.yml` is wired but has never published an image, and the
`production` environment does not exist, so the deploy job's approval gate is
inert. As of 2026-11-09 the workflow publishes to **GHCR** with its own
`GITHUB_TOKEN`, so `REGISTRY_USER`/`REGISTRY_PASSWORD` are no longer needed;
`VITE_LIFF_ID` still is, and a build without it is now refused rather than
published. The matrix is **two** images (`app`, `etl`) — web merged into app on
2026-10-01 — so the acceptance below reads two digests, not three.

- [x] `git push origin main`; confirm `origin/main` contains `4fb470d`, `9724c4d`,
      `c99a277` (`git log --oneline origin/main -3`).
- [ ] **The user** adds the one secret that is still needed
      (`gh secret set VITE_LIFF_ID`) — values are not handled by the agent, and it
      must be the ID read out of the served bundle (`2011592166-uToRdTwS`), never
      retyped from memory. `REGISTRY_USER`/`REGISTRY_PASSWORD` are obsolete with
      GHCR.
- [ ] Create the environment: `gh api -X PUT repos/Bunyakorn-K/CE-Project-2026/environments/production`.
- [ ] Let CI run green on the pushed head; then check the `release` run's summary
      lists **two** image digests (`app`, `etl`), and `gh api .../environments`
      reports 1.
- [ ] Prove one digest resolves from the host that will pull it:
      `docker manifest inspect ghcr.io/bunyakorn-k/ce-project-2026-app@sha256:...`
      — and note that a GHCR package is private by default, so this needs either a
      `docker login` on the VM or a public package.
- [ ] Confirm the deploy job is still **manual** and still does not SSH, run
      `tofu apply`, take a backup or migrate — read the job, do not assume.

**Acceptance:** two digests published by CI from a CI-green commit, recorded in
`docs/02_architecture/deploy-runbook.md`; deploy job still dry. **Not** acceptance:
"CI is green" (it was green while publishing nothing).

**Rollback:** none needed — publishing images changes no running container.

## Task 2 — Attribute the Postgres backend death, and detect the next one in minutes

**Why:** this is PRIORITY 5 of the 2026-09-30 handoff, whose action was "watch".
Watched: it moved. Two cluster reinitializations in the current container, the
newest at **2026-11-09 04:06:26** (`server process (PID 178442) exited with exit
code 2`), and recovery now takes **81 s** (`syncing data directory (fsync),
elapsed time: 81.33 s`) against 20–30 s in September — during which every Airflow
connection is refused (`FATAL: the database system is in recovery mode`). The
cluster is 250 MB and the container has `mem_limit: 512m`.

The instrumentation added 2026-09-30/2026-11-06 (`log_connections`,
`log_disconnections`, `%a`, `log_min_messages=info`) shows the *aftermath*
attributably — client `172.19.0.8` = Airflow, `pg_isready` probes — but the window
before the death still contains no line from the **dying backend itself**, so the
cause remains unattributed.

| Hypothesis | How to falsify it |
|---|---|
| H1 memory pressure (512 MB limit vs 250 MB cluster + fsync buffers) | sample `docker stats --no-stream` every 30 s for 24 h; `dmesg -T \| grep -i oom` at the next crash; check `kernel.msgmax`/shm size |
| H2 connection storm at the hour boundary (Airflow slot churn) | histogram `connection received` per minute from the log and see whether crashes sit on a peak |
| H3 a client that vanishes mid-write (`pg_isready`, LW lock, `signal 13`) | correlate the last `disconnection`/`could not send data to client` per PID with the exit-code-2 PID |
| H4 IO saturation during ETL/ClickHouse merges | `iostat -x 1` samples at crash; compare with `analytics-clickhouse-1` merge activity |

- [x] Add the sampling harness (a shell script under `deploy/`, not a daemon):
      30-second `docker stats`, `dmesg -T`, `pg_stat_database` deltas, written to
      `/opt/laundrytwin/postgres-forensics/` with a size cap.
- [ ] Bound one debug window: `log_min_messages=debug1` + `log_error_verbosity=verbose`
      for at most 24 h, then revert — a `debug1` postmaster on a 250 MB cluster is a
      disk-filling risk on a host with 7.6 GB free, so the revert is part of the task,
      not a follow-up.
- [x] Add `check_postgres_reinit` to `laundrytwin_warehouse_freshness`: compare
      `pg_postmaster_start_time()` against an Airflow Variable and **warn with the
      previous and current start times** when it moves. Detection in one DAG cycle
      instead of retrospectively reading a log 12 hours later.
- [x] Write the attribution — or the honest "still unattributed, and here is what
      would attribute it" — into
      `docs/04_traceability/ops-verification-2026-09-30-postgres-cluster-reinit-forensics.md`
      (extend that record; do not start a second file for one incident).

**Acceptance:** a reinit with the dying backend's own error line, **or** a record
naming the surviving hypotheses with the measurement that excluded each, plus the
detection task running in production. **Not** acceptance: a plausible story with no
crash-window sample behind it.

**Rollback:** drop the added `-c` flags and recreate the container; the detection
task is additive and reverts by deleting one task.

## Task 3 — Make the alert sweep run without a human (R05)

**Why:** `runAlertSweep` is idempotent, cooldowns per `cooldownKey`, claims rows in
`alert_notification`, and audits skips — all correct. Nothing runs it. The only
caller is an owner pressing a button, and an alerts engine that fires when someone
remembers is not R05 ("event-driven notifications with cooldowns").

**Design (decided by a measured network fact, not preference):** the app container
is attached to **`analytics_default`** as well as `laundrytwin_default`
(`docker inspect laundrytwin-app-1`), so Airflow can reach it as `app:8787`
without exposing anything new to the host. Therefore:

- [x] Add `POST /api/internal/alerts/sweep`, guarded by `ALERT_SWEEP_TOKEN` with a
      **timing-safe** compare (the pattern already exists at
      `apps/api/src/analytics/mcp.ts:51`), 401 otherwise. No cookie path, no owner
      path — a machine credential is not an owner session.
- [x] Refactor the existing `notify` handler into one `performAlertSweep()` used by
      both routes, so the manual button and the scheduler cannot drift (two copies
      of one contract is the repository's named failure mode).
- [x] Add `deploy/analytics/dags/laundrytwin_alert_sweep.py`, `*/5 * * * *`, stdlib
      `urllib` (same shape as `laundrytwin_warehouse_freshness.py`), token from an
      Airflow Variable, `max_active_runs=1`, and a **FAIL when the response is not
      200** — a sweep that silently 401s is the same defect class as a monitoring
      check that exists but does not run.
- [x] Tests: 401 without token; 200 with token; identical summary shape from both
      routes; a second sweep inside the cooldown window sends nothing and reports
      `cooldown > 0`.
- [ ] Deploy (gated), then read the DAG run log and paste the real summary JSON into
      `docs/04_traceability/ops-verification-2026-11-XX-alert-sweep-scheduled.md`.

**Acceptance:** a DAG run **in production** whose log carries the sweep summary, and
`/api/admin/alerts/notify` still working. A `0 alerts` result is a valid pass — IRIS
may simply have none — but it must say `scanned: 0` rather than an empty body, and
the record must not read "alerts verified" on that basis.

**Rollback:** `docker compose stop` the DAG (pause it in Airflow) and redeploy the
previous image tag; the route is additive.

## Task 4 — Gas pressure trend, with the safety boundary written into the code (R06)

**Why:** 259,356 samples are collected hourly and **nothing reads them**. R06 is
"pressure trends may support a low-gas estimate *when evaluated with machine state
and temperature*" — a conditional requirement, not a pressure-threshold alarm.

Facts that constrain the design: `value_psi` is `Nullable(Float32)` and
`unavailable` is stored as **NULL, never 0** (observed minimum 9 psi);
`channel` is one of `gas_run_a_pressure`, `gas_run_b_pressure`,
`changeover_filter_pressure`; `gas_detector_*` entities are a liveness heartbeat
and are **excluded by contract**.

- [x] `apps/api/src/gas-trend.ts`: pure `evaluateGasTrend(samples, context)` returning
      `unknown` / `steady` / `declining` **plus its evidence** (window, sample count,
      coverage %, minutes of NULL inside the window, machine state and temperature
      observed, threshold version). Missing or mostly-NULL window ⇒ `unknown`, never
      a trend.
- [x] Thresholds in one exported, versioned object; no magic numbers in the caller.
      A declining trend with the branch **positively closed** must not be reported
      (machines idle, pressure steady is not a finding).
- [x] Emit into Task 3's sweep as `ruleId` prefixed `gas.` so cooldown keys cannot
      collide with IRIS rule ids; reuse `claimNotification` unchanged.
- [x] Contract doc: add the thresholds, the "not a leak detector" boundary and the
      "no claim from a single dip" rule to
      `docs/03_data_contracts/ha_gas_sensor_contract.md`.
- [x] ≥20 tests on the pure decision, including: all-NULL window ⇒ `unknown`;
      50 % coverage ⇒ `unknown`; closed branch ⇒ no alert; single dip ⇒ no alert;
      monotone decline over ≥3 h with machine running ⇒ `declining`; and that no
      `gas_detector` entity can ever produce an alert.

**Acceptance:** in production, the sweep summary carries a `gas evaluated` count and
its window. **Not** acceptance: any wording that reads as leak detection.

**Rollback:** the rule is additive to the sweep; remove its call site.

## Task 5 — Audit what the AI actually calls (R08 / F-07)

**Why:** the assistant and its 6 MCP tools have a bearer token and a scope boundary,
but no record of what was called with what. `audit_log` exists and is used for
grants, alerts and settings — the AI path simply never writes to it.

- [x] One row per tool call: `action='ai.tool_call'`, `target=<tool name>`,
      `detail` = JSON `{model, toolCallId, argsDigest, argsKeys, resultRows,
      durationMs, outcome}` where `argsDigest` is a SHA-256 over canonicalised args.
      **Digest, not raw args** — arguments carry branch ids and revenue scopes, and
      an audit table is the wrong place to accumulate a second copy of them. State
      that tradeoff in the doc so nobody later "fixes" it by logging raw args.
- [x] One row per chat request: `action='ai.chat'` with model, message count, and
      whether the answer used any tool.
- [x] Decide retention explicitly: `POST /api/ai/chat/purge` clears conversation
      content only; audit rows are append-only. Test both halves.
- [x] Tests: exactly one audit row per tool call **including when the tool throws**;
      no environment value (token, DSN) appears anywhere in `detail`; purge leaves
      audit intact.

**Acceptance:** a real `/api/ai/chat` call in dev leaves the expected rows, quoted in
the evidence record. **Not** acceptance: unit tests alone — this is the requirement
whose whole point is that a real call was recorded.

**Rollback:** additive writes; reverting the image stops new rows.

## Task 6 — ML: correct the guide, build the dataset, compare three candidates (R09)

**Why:** every ML document says the warehouse is **19 days short** of the 90-day
gate (71 days, measured 2026-09-30). It is not short any more: **110 distinct days**
(2026-07-22 → 2026-11-09, one known source gap at 2026-07-27). The gate released
itself and nothing noticed — that is the finding.

- [x] Update `docs/06_ml/ml-training-data-guide.md` §5 and §9.1 with the measured
      numbers (rows, distinct days, span, the `2026-07-27` gap, attribution share),
      each with the measurement date. The guide is the single source for these; do
      not restate them in `AGENTS.md`.
- [x] Build `fact_ml_features` — currently declared in the guide §4.1 and
      implemented **nowhere** (`grep` finds no code). Daily aggregation, one row per
      branch × machine × hour, NULL-preserving: a missing hour is NULL, never 0.
- [x] One reproducible command builds it and prints its own row/day counts, so the
      dataset can be re-derived rather than trusted.
- [x] Comparison harness with a **fixed** split (last 14 days held out, no shuffling):
      seasonal-naive baseline, then Prophet, SARIMA, and a gradient-boosted tree, on
      hourly cycle counts per branch. Report MAE/MAPE per candidate including the
      baseline — a model that does not beat seasonal-naive is the honest result.
- [x] Record the decision (adopt / do not adopt) in
      `docs/04_traceability/`, with the two caveats that constrain any claim:
      ~68 % of usage rows carry no `machine_session_id` (attribution, not activity,
      is what is missing), and the weather source is one effective series for both
      provinces, so "weather impact" is weaker than it reads.

**Acceptance:** guide corrected with dated measurements; dataset reproducible by one
command; four numbers (three candidates + baseline) recorded. **Explicitly not**
acceptance: a deployed model, or a metrics table without the baseline row.

**Rollback:** none — nothing in this task touches production.

---

## Cross-cutting rules for whoever executes this

1. **A requirement is not met because tests pass.** R05 closes on a DAG run log; R08
   closes on a recorded real call; R06 closes on a production sweep summary.
2. **Evidence lands in `docs/04_traceability/`**, one file per change, named
   `ops-verification-YYYY-MM-DD-<subject>.md`, with the exact timestamp and the
   command that produced each number.
3. **No secret is printed, committed, or pasted into a record** — `REGISTRY_PASSWORD`,
   `ALERT_SWEEP_TOKEN`, `AIRFLOW_DB_PASSWORD`, `LINE_CHANNEL_ACCESS_TOKEN` and the
   IRIS API key all stay in env files; records quote variable *names* only.
4. **Deploys are gated** (see top). Two of these tasks change a running container;
   both need a rollback tag in the record.
5. **A gap found while doing a task becomes its own plan**, not a silent fix inside
   this one — the pattern that produced `2026-11-08-sign-out-reauthentication-defect.md`.

## Done means

- CI has published three images and the environment gate exists (Task 1).
- A reinit is either attributed or excluded by measurement, and detected within one
  DAG cycle (Task 2).
- The sweep runs every 5 minutes in production with a logged summary (Task 3).
- Gas is evaluated with state and temperature, `unknown` where evidence is missing,
  and no text anywhere calls it leak detection (Task 4).
- AI tool calls are audited with digests, and real rows exist (Task 5).
- The ML guide is correct, the dataset is reproducible, and three candidates are
  compared against seasonal-naive (Task 6).

---

## Execution log, 2026-11-09

| Task | Reached | Evidence |
|---|---|---|
| 1 — land + CI publish | **pushed** (12 commits, `origin/main` = `67e32aa`). Secrets and the `production` environment are **not created**: the agent's GitHub token is not a repository admin (`gh api -X PUT .../environments/production` → `403 Must have admin rights`), so this needs the human. No image has been published by CI. | this plan, task 1 |
| 2 — Postgres reinit | detection task **live in production** (warn path exercised on a real run); 24 h sampler running; attribution **not established**, two hypotheses excluded by measurement and one channel (the log stream) shown to have broken first. The `debug1` window was **not** opened — it needs a postgres restart. | `ops-verification-2026-09-30-postgres-cluster-reinit-forensics.md` §10 |
| 3 — alert sweep (R05) | route + DAG + tests **built**; **not deployed**, so **not closed**. The DAG file is deliberately not on the box yet: it would 404 every 5 minutes. | `ops-verification-2026-11-09-alert-sweep-scheduled.md` |
| 4 — gas trend (R06) | pure decision + wiring + contract **built and tested against real production rows**; **no sweep has run**, so **not closed**. The decision rule was corrected by a production measurement (edge rate, not fitted slope). | `ops-verification-2026-11-09-gas-trend-evaluation.md` |
| 5 — AI audit (R08/F-07) | rows + purge **built and tested**; a **real `/api/ai/chat` call** in dev leaves the expected row. No real tool call recorded; nothing in production. | `ops-verification-2026-11-09-ai-audit.md` |
| 6 — ML (R09) | guide corrected from measurements; `fact_ml_features` **built in production** (61,272 rows, 456 NULLs = the `2026-07-27` gap day); four candidates compared on a fixed 14-day holdout; **decision: adopt none**. | `ops-verification-2026-11-09-ml-dataset-and-candidates.md` |

**Every deploy in this plan remains blocked on the missing warehouse backup.**
