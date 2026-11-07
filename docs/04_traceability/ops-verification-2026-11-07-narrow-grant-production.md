# Narrow-Grant Production Verification — 2026-11-07

**Fixture:** narrow-test@laundrytwin.local (technician, branch 5e9611c1-6380-4d58-8ec7-ba4fb8fe4369)
**Grant ID:** 6139f917-e514-4cd9-af39-33a8c0dcb9b6
**Dashboard in-scope:** 200 (after reader restoration 2026-11-07; earlier REPORTING_SOURCE_FAILED was the reader user bug, not IRIS)
**Out-of-scope:** BRANCH_FORBIDDEN 403 — PASS (before any warehouse query)
**Revenue:** REVENUE_FORBIDDEN 403 — PASS (before any warehouse query)
**Zero-grant:** `ACCESS_NOT_GRANTED` 403 on both `/api/report/branches` and `/api/report/dashboard` — PASS (second account `zero-grant@laundrytwin.local`, 0 grants, tested 2026-11-07)

The earlier dashboard failure was not narrow-grant-specific: owner session returned the same REPORTING_SOURCE_FAILED because the ClickHouse `reader` user was missing (fixed in `ops-verification-2026-11-07-clickhouse-reader-restoration.md`).
