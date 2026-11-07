# Narrow-Grant Production Verification — 2026-11-07

**Fixture:** narrow-test@laundrytwin.local (technician, branch 5e9611c1-6380-4d58-8ec7-ba4fb8fe4369)
**Grant ID:** 6139f917-e514-4cd9-af39-33a8c0dcb9b6
**Dashboard in-scope:** REPORTING_SOURCE_FAILED (pre-existing — IRIS not configured / ClickHouse unreachable for dashboard route, affects owner too)
**Out-of-scope:** BRANCH_FORBIDDEN 403 — PASS (before any warehouse query)
**Revenue:** REVENUE_FORBIDDEN 403 — PASS (before any warehouse query)
**Zero-grant:** not tested (needs second account — deferred)

The dashboard failure is NOT narrow-grant-specific: owner session returns the same REPORTING_SOURCE_FAILED. This is a pre-existing data source issue, not a scope leak.
