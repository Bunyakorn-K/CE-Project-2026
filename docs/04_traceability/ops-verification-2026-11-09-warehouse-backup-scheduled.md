# The warehouse now has an automated, verified daily backup

**Date:** 2026-11-09
**Files:** `deploy/analytics/backup-clickhouse.sh`,
`deploy/analytics/backup-clickhouse.test.sh`,
`deploy/analytics/laundrytwin-clickhouse-backup.service`,
`deploy/analytics/laundrytwin-clickhouse-backup.timer`
**Status: scheduled and running in production; a restore of the first real
backup was performed and checked.**

## Why this came first

Every deploy in `docs/superpowers/plans/2026-11-09-requirement-closure-batch.md`
was gated on a warehouse backup that did not exist. The repository said so in
four documents, and the plan called it "a prerequisite for every deploy in this
plan, not a task inside it".

Measured on the host before starting:

```text
systemctl list-timers --all | grep -i backup   → only dpkg-db-backup.timer
crontab -l                                     → crontab: command not found
/opt/analytics/backup-clickhouse.sh            → absent
/data/backups/clickhouse/                      → two hand-made entries from 2026-11-07
```

So the helper existed in the repository and had a passing test, and nothing had
ever run it — the VM has **no cron binary at all**, which is why "scheduled by
hand" was the only thing that ever happened.

## Three defects in the helper, found by running it

The first real run failed three times, for three different reasons. Each is now
a refusal with a test, because each produced a *successful-looking* result:

| # | Defect | What it produced | Now |
|---|---|---|---|
| 1 | `Disk('backup', …)` while `clickhouse-backup-disk.xml` declares the disk **`backups`** | `Disk 'backup' not found` on every call — nothing could ever have been scheduled with it | `BACKUP_DISK` (default `backups`), asserted against the captured SQL |
| 2 | verification read `WHERE name = '<name>'`, but `system.backups.name` is the whole target string `Disk('backups', '<name>')` | status came back empty → "<empty>, not OK" on a backup that had just been created | `position(name, '<name>') > 0`, with the name restricted to `[A-Za-z0-9._-]` |
| 3 | success status expected to be `OK`, but this server reports **`BACKUP_CREATED`** (26.3.26.3) | the helper refused every successful backup | both accepted; anything else refuses |

Two more guards were added for failure modes this host has actually produced:

- **A backup of the wrong database is refused by size.** The only "successful"
  backup on the host before today — `pre-closed-rendering-test`, 2026-11-07 —
  holds **11 files and 3.85 KiB** of the `default` database because
  `CLICKHOUSE_DATABASE` was unset in that shell. `num_files > 0` and
  `total_size ≥ 1,000,000` are now asserted. This is the ClickHouse form of the
  same trap `AGENTS.md` records for SQLite: a copy-sized backup is a failed
  backup, not a small one.
- **Free space is checked before writing.** `/` had 7.9 GB free against a 16 GB
  ClickHouse volume; `MIN_FREE_MB` defaults to 1024 and refuses rather than
  leaving a half-written backup that looks like one.

The credential is passed through curl's `--config <(...)` channel as HTTP Basic,
never on argv: `-u admin:…` would be readable in `/proc` by any local user. The
first attempt used form fields, which ClickHouse ignores — the 401 it answered
said `default: Authentication failed` while the script was sending `user=admin`.

## Scheduled

`laundrytwin-clickhouse-backup.timer` → daily at **02:30 UTC** (09:30 Bangkok,
after the overnight merge cycle), `Persistent=true` so a missed day runs on the
next boot instead of vanishing, `RandomizedDelaySec=300`, and a 30-minute
`TimeoutStartSec`. Installed on the VM as
`/etc/systemd/system/laundrytwin-clickhouse-backup.{service,timer}` with
`/opt/analytics/backup.env` (600, root) for the non-secret knobs; the credential
is read from `/opt/analytics/.env`, which already held it.

```text
# systemctl list-timers laundrytwin-clickhouse-backup.timer
NEXT                        LEFT  LAST PASSED UNIT
Tue 2026-11-10 02:30:45 UTC 17h   -    -      laundrytwin-clickhouse-backup.timer
```

Retention: `KEEP_BACKUPS=7`, and only names starting `laundrytwin-` are pruned —
the hand-made `pre-*` backups are never touched by the timer.

## Verified: the backup contains the warehouse

First scheduled-format run, `2026-11-09 09:11:19 UTC`:

```text
ClickHouse backup OK: /data/backups/clickhouse/laundrytwin-20261109T091119Z.done
                      (784 files, 120420858 bytes)
```

115 MiB for a database that measures 114.71 MiB on disk, so the size matches the
source rather than a subset of it. Then the check that actually matters — **a
restore of that backup into a scratch database**:

```sql
RESTORE DATABASE laundrytwin_analytics AS laundrytwin_bk_verify
  FROM Disk('backups', 'laundrytwin-20261109T091119Z');
-- 15.5 s, status RESTORED, 11 tables
```

| table | live (at 09:12) | restored from the 09:11:19 backup |
|---|---|---|
| `fact_machine_usage` | 13,477 | **13,471** |
| `fact_temperature_sample` | 2,712,599 | **2,712,247** |
| `fact_ml_features` | 61,272 | **61,272** |

The small deltas are the ETL's 5-minute ingest between the snapshot and the
count — a backup is a moment, not a mirror. `laundrytwin_bk_verify` was dropped
afterwards (0 tables remain), so the restore test left nothing behind.

## What this does and does not change

- **It unblocks the deploy gate's backup prerequisite** for
  `docs/superpowers/plans/2026-11-09-requirement-closure-batch.md`. The other
  gate items still apply: an explicit request, a named rollback image, a
  `db.backup()`-taken and verified SQLite backup, and a post-change smoke test.
- **It does not back up the app SQLite.** That is still a manual
  `await db.backup(...)` at deploy time, because the WAL-mode trap makes a file
  copy useless and this timer has no access to the running app's handle.
- **It is a same-host backup.** `/data/backups/clickhouse` is a host bind mount,
  outside the ClickHouse volume (so a volume loss does not take the backup), but
  on the same disk as everything else. An off-host copy is still outstanding and
  is the next thing worth doing about backups.
- The first two months of temperature history still cannot be reloaded from
  IRIS; a backup protects what is there now, not what was lost before.

## Rollback

```bash
sudo systemctl disable --now laundrytwin-clickhouse-backup.timer
sudo rm -f /etc/systemd/system/laundrytwin-clickhouse-backup.{service,timer}
sudo systemctl daemon-reload
```

That removes the schedule and leaves every backup already written on disk. To
free the space, delete `/data/backups/clickhouse/laundrytwin-*` — nothing else
reads them.
