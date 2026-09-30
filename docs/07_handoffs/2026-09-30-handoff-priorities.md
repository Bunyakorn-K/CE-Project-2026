# Handoff — ลำดับงานที่ควรทำต่อ (2026-09-30)

**For a teammate or an AI picking this up cold.** This file replaces
`2026-09-30-next-session-plan.md` as the working entry point. That file is 616
lines, was written mid-session, and two of its claims are now wrong (see
[Superseded claims](#superseded-claims)). Read this first, then the evidence
record named per item.

**Repo state at time of writing:** `main` at `44f9770`, working tree clean,
**0 unpushed commits**. 417 tests green (API 277 / web 53 / ETL 87).

**Today's work is closed and pushed.** Three scoped items finished: the gas
collector deploy, the `fact_temperature_sample` de-duplication, and the
Postgres/Airflow forensics. What follows is what is *left*.

---

## The one thing to do first

**LaundryTwin has no automated backup of the ClickHouse warehouse. Not one
channel.** This was measured on 2026-09-30 14:0x UTC, not inferred.

| Channel | Result |
|---|---|
| root crontab | 0 lines |
| user crontab | 0 lines |
| `/etc/cron.d` | only `e2scrub_all` (filesystem scrub, not a backup) |
| systemd timers | only `dpkg-db-backup` (OS package lists) |
| ClickHouse `system.backup_schedule` | table does not exist on this server |

Every backup that exists was taken by hand, immediately before a specific
intervention:

```text
/opt/backups/pre-upgrade-20260831/    2026-08-31  (mode 0644 — see PRIORITY 3)
/opt/backups/pre-deploy-20260929/     2026-09-29  (mode 0600)
/opt/backups/pre-merge-20260930/      2026-09-30  (mode 0600)
```

There is no schedule and no retention policy. "The backup is current" is only
ever true because someone ran `tar` by hand that day.

**Why this ranks above everything else.** The warehouse holds **2,258,533
temperature rows** spanning 2026-05-26 → 2026-09-29, and roughly the first two
months of that **cannot be reloaded from IRIS** — the source
`machine_temperature_sample` table now starts at 2026-07-01. That data exists
in exactly one place. Meanwhile:

- The host has OOM-killed ClickHouse **16 times** (`oom-kill: task=clickhouse-serv`).
- On 2026-09-17 a rollback was started against a correct backup that was
  **deleted 8 seconds before the restore began**. The volume was rolled back to
  a 2026-08-31 snapshot. The 17 missing days were orphaned rather than
  destroyed, and were recovered by hand on 2026-09-30 — but the near-miss was
  real, and the deletion was not a coincidence of bad luck.

**Suggested shape** (needs approval — this touches production):

- ClickHouse native `BACKUP ... TO disk`, scheduled via `system.backup_schedule`,
  writing to `/opt/backups/clickhouse/` on a partition that is not the same
  filesystem as the live volume where possible.
- Retention: keep daily × 7, weekly × 4, monthly × 6. The volume is **6.2 GB**;
  the root filesystem has **34 GB free of 79 GB**, so this fits without
  cleverness.
- **A restore drill is part of the deliverable, not a follow-up.** A backup
  that has never been restored is not a backup. Rehearse into a scratch volume
  and verify row counts and `max(recorded_at)` against the live table.
- Add `BACKUP` to the production rollout gate in
  `docs/02_architecture/deploy-runbook.md` so "was there a backup, and when"
  is asked before every future change.

**Read first:** `docs/04_traceability/ops-verification-2026-09-30-warehouse-data-recovery.md`
§1 — it records the 2026-09-17 procedure and the two missing guards below.

**Do not** point this at the same disk only and consider it done. A backup that
dies with the volume it protects is not a backup.

---

## PRIORITY 2 — Host memory limits

**Every one of the 22 containers on the VM reports `Memory=0`** — no cgroup
limit at all. The host has 10.8 GiB RAM and 4 GiB swap, shared with an
unrelated LibreChat / MongoDB / Meilisearch / Arcane stack. All 22 host OOM
kills come from that unbounded sharing.

- ClickHouse has a **server-side** 3 GiB cap
  (`deploy/analytics/clickhouse-memory.xml`, added after the 2026-09-16 OOM
  took the box down) but **no container limit**. That is precisely why it keeps
  being chosen as the victim: nothing stops the kernel picking it.
- Measured: ClickHouse 1.29 GiB, two Airflow components ~0.91 GiB each.

This is a separate change from the Postgres forensics below, and it was
explicitly deferred there as its own piece of work. It pairs well with
PRIORITY 1: the backup limits the blast radius of data loss, the memory limits
limit how often something dies at all.

**Read first:** `docs/04_traceability/ops-verification-2026-09-30-postgres-cluster-reinit-forensics.md`
§5, second half.

---

## PRIORITY 3 — Credential and file-permission hygiene

Untouched. Two sub-groups, only the second is quick.

### 3a. Credentials still to rotate or remove

- [ ] `SUPERSET_DB_PASSWORD` — it appeared in this project's session
      transcript. The value is **deliberately not reproduced in any committed
      file**; rotate it directly on the host. Note the compose comment above
      `SUPERSET_DATABASE_URI` (`deploy/analytics/compose.yaml:210-220`): the
      `superset` database and the
      `superset_app` role are **created by hand on each host**, and the grants
      that actually exist are not recorded in the repo. Rotating the password
      may therefore also mean re-granting.
- [ ] `ANALYTICS_READ_API_KEY` — remove.
- [ ] `X-Dash-Token` — 49 hex chars embedded in the Caddyfile **on the Pi** at
      the site, not on the VM. Separate host, separate access path.
- [ ] `clickhouse_password` Airflow Variable — a ClickHouse credential sitting
      in the Airflow metadata database.
- [ ] `chtest7` — an exited `clickhouse-server:26.3` container (exit 76) still
      present on the host.

### 3b. Backup archives are world-readable — fix this, it takes seconds

```text
644 root:root 1814455646  /opt/backups/pre-upgrade-20260831/clickhouse-data.tgz
644 root:root   17226556  /opt/backups/pre-upgrade-20260831/superset-home.tgz
644 root:root    1302916  /opt/backups/pre-upgrade-20260831/airflow-data.tgz
600 uunw:uunw           /opt/backups/pre-deploy-20260929/...   <- correct
```

The 2026-08-31 set is `0644`, readable by every user on a host that also runs
an unrelated multi-user application stack. `superset-home.tgz` contains
`SUPERSET_SECRET_KEY`. The newer backups are correctly `0600`, so this is an
inconsistency, not a policy.

```bash
sudo chmod 0600 /opt/backups/pre-upgrade-20260831/*.tgz
```

No rollback needed; the mode change is the fix. Re-verify with
`sudo stat -c "%a %U:%G %n" /opt/backups/pre-upgrade-20260831/*.tgz`.

Also unaddressed: the container registry lives on the same host as its only
client (`10.10.0.117:5000`), so it is a single point of failure for every
deploy.

---

## PRIORITY 4 — The two restore-time guards

Still open, and the detection half does **not** cover them.

`check_usage_continuity` in `deploy/analytics/dags/laundrytwin_warehouse_freshness.py`
was added on 2026-09-30 and now runs first in the freshness DAG, reporting
day-shaped holes in `toDate(started_at)`. That closes **detection**. It runs
against the live warehouse on a schedule; it does nothing to stop a bad restore.

- [ ] **Restore-source freshness gate.** A restore must refuse a source backup
      that is not newer than the target it would overwrite.
- [ ] **Post-restore continuity assertion before any compose switch.** Compare
      `max(extracted_at)` across the boundary and abort rather than starting
      containers on a warehouse that is silently behind.

Both belong in the restore procedure itself, in
`deploy/analytics/`, with a unit test each. Neither requires touching the
running system, so both can be written and tested locally.

---

## PRIORITY 5 — Postgres crash trigger (armed, now waiting)

The Airflow restart is **fully explained**: a Postgres backend dies → the
postmaster treats it as possible shared-memory corruption and reinitializes the
whole cluster (~20–30 s, all connections refused) → `restart: unless-stopped`
brings Airflow back. Airflow is the symptom, not the fault.

**59 cluster reinitializations** since 2026-09-06T20:01:21Z, last at
2026-09-30T10:55:47Z. 55 of 59 carry an explicit cause: 39 × `exit code 2`,
16 × `signal 13: Broken pipe`. OOM is ruled out by three independent proofs
(Postgres is never the `oom-kill: task=` victim; its cgroup `oom_kill` counter
is 0; the final crash is 13.8 days after the last OOM with no memory pressure).

**The trigger is still not identified and must not be recorded as benign.**

The blocker was a logging gap, and it is now closed: `log_connections=on`,
`log_disconnections=on`, and `log_line_prefix='%m [%p] app=%a client=%h'` were
applied via `ALTER SYSTEM` + `pg_reload_conf()` on 2026-09-30 with **no
postmaster restart** (`pg_postmaster_start_time()` unchanged, `RestartCount=0`),
and are mirrored in `deploy/analytics/compose.yaml` so a recreated container
keeps them.

**Next action: none required, just watch.** The reinit count was still exactly
59 at 14:02 UTC. When it next moves, the crash window will name its client in
`app=%a client=%h`. Capture that window and update
`docs/04_traceability/ops-verification-2026-09-30-postgres-cluster-reinit-forensics.md`
§7. That is the only route to the trigger.

Also open in that record: 19 of 59 crashes have no OOM within 30 min, and 4 of
the 55 cause lines do not account for all 59 reinitializations.

---

## PRIORITY 6 — Housekeeping

- [ ] Drop `fact_temperature_sample_pre_dedup` (~125 MiB) once 2–3 more clean
      ETL cycles have passed. It is the rollback target for the 2026-09-30
      de-duplication and is **not** dropped by that migration by design.
- [ ] Re-check whether any other API query counts `fact_temperature_sample`.
      The temperature curve's `totalCount` was measured; other count surfaces
      were not.
- [ ] **ML data sufficiency.** 71 days of usage data is still short of the ≥90
      days (3 months) required for the Prophet / SARIMA / GBM candidates in
      `docs/06_ml/ml-training-data-guide.md` §5. Nothing to code — this
      resolves with elapsed time, but do not start a model run before it.

---

## Verified state — gas pressure collector (2026-09-30 14:07 UTC)

Asked and answered during this session; recorded here so it is not re-derived.

**Yes, it is collecting, and it is working correctly.**

| Check | Result |
|---|---|
| Container | `laundrytwin-gas-1` Up, healthy, `restarts=0` |
| Loop | `while true; do node --import tsx src/gas-run.ts; sleep 3600; done` |
| Rows | **895** |
| Distinct `(tenant_id, branch_id, entity_id, recorded_at)` | **895 — zero duplicates** |
| Window | 2026-09-30 10:35:45 → 13:36:18 |
| Age of newest sample | 31 min (next run ~14:36) |
| `value_psi` NULL / zero | **0 / 0** — `unavailable` is never coerced to 0 |
| psi range | 15–111 |

| entity_id | channel | rows | psi |
|---|---|---|---|
| `sensor.otterimju2_gas_pressure_a` | `gas_run_a_pressure` | 98 | 17–21 |
| `sensor.otterimju2_gas_pressure_b` | `gas_run_b_pressure` | 347 | 87–111 |
| `sensor.otterimju2_changeover_pressure` | `changeover_filter_pressure` | 450 | 15–21 |

No `gas_detector_*` entity is present, which is correct — they are a liveness
heartbeat, not a leak detector, and are excluded deliberately.

**Why zero duplicates, when `fact_temperature_sample` had 1.5M.** The gas table
is `ReplacingMergeTree` with sort key
`(tenant_id, branch_id, channel, recorded_at)` and partition `toYYYYMM(recorded_at)`.
The temperature table was a plain `MergeTree` when it duplicated. Each cycle
re-reads a ~3-hour overlapping window (at-least-once, same shape as the
temperature bug) but the engine converges it, so the re-read is free apart from
consumed I/O. The gas contract is in
`docs/03_data_contracts/ha_gas_sensor_contract.md`.

**Two things a reader should not misread:**

1. There are `Code: 497 … Not enough privileges` errors in the container log
   at **13:33 and 13:34**. They are historical — they predate the
   `GRANT INSERT, CREATE TABLE ON laundrytwin_analytics.fact_gas_pressure_sample
   TO etl_writer` step. Runs at 13:35 and 13:36 succeeded, and nothing has
   failed since. This is the exact failure `AGENTS.md` warns about: the DDL is
   applied by `etl_writer` itself, so creating a table grants that user nothing,
   and it only surfaces at the first INSERT.
2. `gas_run_b_pressure` drifted 87 → 111 psi over three hours while A and the
   changeover filter sat still. **This is not a conclusion about gas.** Three
   hours of one sensor's readings supports no claim, and pressure trends may
   only support a low-gas estimate when read together with machine state and
   temperature. Do not let this become a gas narrative without more evidence.

Nothing in the Digital Twin or the cycle/revenue KPIs reads this table yet, and
no alert is raised from it. That is by design.

---

## Superseded claims

Two statements in `2026-09-30-next-session-plan.md` are now wrong. Both were
corrected in the forensics record, but flagging them so nobody re-derives from
the old plan:

- The old plan's PRIORITY 4 said the container restarts were unexplained and
  "the trigger was never determined and must not be recorded as benign." The
  chain is now fully proven and the trigger is *still* not determined — but the
  reason is now specific and fixable (connection logging was off, and the log
  prefix named neither client nor application), not a general absence of
  evidence. See PRIORITY 5.
- The old plan's "Current State" says the session was unpushed at `7409f5f`.
  Everything through `44f9770` is pushed.

A related correction now recorded in the forensics record: an earlier note
claimed `dmesg` was empty. It is not — `journalctl -k` carries all 22 OOM
events. An earlier account of the temperature migration also claimed "the logs
contain no detail"; they carry an explicit cause for 55 of 59 events.

---

## Ground rules for whoever picks this up

- **Production changes need an explicit go-ahead**, a stated rollback target,
  and a post-change smoke test. Pushing code is not authorization to deploy,
  migrate, or touch a live machine. Everything in PRIORITY 1 and 2 falls under
  this; PRIORITY 3b and 4 do not, and can be done immediately.
- **SSH to the VM is `ssh -J dietpi@dietpi uunw@172.30.191.48` and nothing
  else.** `sudo` is required for `docker` on that host — `uunw` is not in the
  `docker` group.
- **Never touch `~/.ssh/known_hosts`.** Use a throwaway
  `-o UserKnownHostsFile=/tmp/...` per session.
- **When anything touches ClickHouse, verify volume identity** (`CreatedAt` +
  mountpoint) before and after. Two volumes share the same Atomic table UUID
  because one was a `tar -x` copy, and part *names* differ legitimately across
  merge boundaries — comparing part names is not comparing lineage. Attaching
  the wrong volume comes up as a complete data loss that is not real. See
  `docs/04_traceability/ops-verification-2026-09-30-warehouse-data-recovery.md`.
- **Any new warehouse table needs a grant the code cannot perform:**
  `GRANT INSERT, CREATE TABLE ON laundrytwin_analytics.<table> TO etl_writer;`
  `SELECT` is deliberately never granted to `etl_writer` on fact tables.
- **Status is numbered by IRIS lifecycle order**
  (`pending_payment=1, paid=2, admitted=3, running=4, finished=5, cancelled=6`).
  Filter by name, never by number.
- **Unattributed share is a live metric, not a constant.** It was 67.8933%
  (5,369 of 7,908) measured 2026-09-30 11:39:11 UTC. Any figure quoted without
  a measurement date is stale.
- **Never commit credentials, provider tokens, production databases, customer
  data, live captures, or `.env` files.** Git hooks run `gitleaks` pre-commit
  and pre-push; `--no-verify` must never be used to land a real secret.

## Where the evidence lives

| Document | Covers |
|---|---|
| `docs/04_traceability/ops-verification-2026-09-30-warehouse-data-recovery.md` | the 17-day hole, the 09-17 rollback, the deleted backup, volume identity traps |
| `docs/04_traceability/ops-verification-2026-09-30-postgres-cluster-reinit-forensics.md` | the Airflow restart chain, 59 reinitializations, the logging fix |
| `docs/04_traceability/ops-verification-2026-09-30-temperature-dedup-migration.md` | 3,762,139 → 2,258,219, the `FINAL` placement bug, why a reload was impossible |
| `docs/04_traceability/ops-verification-2026-09-30-gas-collector-deploy.md` | the 5-step deploy, grant step, `gas_detector_*` exclusion |
| `docs/03_data_contracts/ha_gas_sensor_contract.md` | gas field contract, units, the safety boundary |
| `docs/02_architecture/deploy-runbook.md` | topology, rollout gate, troubleshooting quick reference |
