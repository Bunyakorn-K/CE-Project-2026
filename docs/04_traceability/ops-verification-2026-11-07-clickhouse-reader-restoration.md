# Ops verification — ClickHouse reader restoration (2026-11-07)

## Symptom

Signed-in dashboard returned `502 REPORTING_SOURCE_FAILED` for
`/api/report/branches` and `/api/report/dashboard`.

## Root cause

`/opt/analytics/clickhouse-reader.xml` on VM 117 was an **empty directory**,
not a regular file. Docker mounted the directory over
`/etc/clickhouse-server/users.d/reader.xml`, so ClickHouse never loaded the
`reader` user definition. API authenticates as `reader`, which did not exist
in `system.users` (only `admin` and `etl_writer` were present).

A second issue compounded it: the repository's
`deploy/analytics/clickhouse-reader.xml` uses
`<password from_env="CLICKHOUSE_READER_PASSWORD"/>`, but the container
environment variable was blank at recreate time. The host already had a
working `clickhouse-reader.local.xml` with the literal password already in
use.

## Fix

1. Replaced the empty directory with the working local file:
   `cp /opt/analytics/clickhouse-reader.local.xml /opt/analytics/clickhouse-reader.xml`
2. Added native backup disk config (`deploy/analytics/clickhouse-backup-disk.xml`)
   and mount `/data/backups/clickhouse:/backups`.
3. Recreated `analytics-clickhouse-1`.

## Verification

| Check | Result |
|---|---|
| `SELECT name FROM system.users` | `reader, admin, etl_writer` |
| `GET /api/report/branches` | 200, `source: clickhouse`, 3 branches |
| `GET /api/report/dashboard` | 200, 829 usage rows, 534 cycles |
| Native backup `BACKUP DATABASE ...` | `BACKUP_CREATED`, 67 MB ZIP at `/data/backups/clickhouse/pre-reader-restoration.zip` |
| Regression guard `check-reader-mount` | 3/3 pass locally and on VM |

## Still open

- The repository `clickhouse-reader.xml` still uses `from_env`; a future
  recreate will hit the blank env again. Use the literal local file or set
  `CLICKHOUSE_READER_PASSWORD` in the VM env before any future recreate.
