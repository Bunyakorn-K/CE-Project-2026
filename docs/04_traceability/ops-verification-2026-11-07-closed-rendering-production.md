# Closed Rendering Production Verification — 2026-11-07

**Fixture:** sandbox branch `e9b98f78-38af-4533-b155-6a7c92668b5b` (4 machines, 0 usage rows)
**Schedule test:** `open_minute=0, close_minute=360` (00:00–06:00 Bangkok) — closed at 17:34 local

## Result

| Check | Result |
|---|---|
| Sandbox `branchOpenState` after insert | `closed` (all 4 machines) |
| Sandbox after rollback | `unknown` (all 4 machines) |
| Real branch `5e9611c1` during test | `open` (3 machines checked, `stale` freshness) — unaffected |
| Rollback verified | sandbox row removed, API resolves `unknown` again |

## Note on first attempt

An initial `open_minute=0, close_minute=0` row did not render `closed` because `isUsableHours` rejects zero-length windows (`openMinute === closeMinute`). This is correct behavior — a zero-length window is not a schedule. The valid `00:00–06:00` window correctly resolved to `closed`.

## Evidence

- `dim_branch_hours` before: only real branch 24/7 row (`0, 1440, version 1`)
- During test: sandbox row (`0, 360, version 3`) + real branch unchanged
- After rollback: only real branch row remains
- API: `GET /api/report/live?branchId=<sandbox>` → `branchOpenState: closed` during test, `unknown` after
- API: `GET /api/report/live?branchId=<real>` → `branchOpenState: open` throughout
- Backup: native `BACKUP TABLE dim_branch_hours` to `pre-closed-rendering-test` (ZIP, on `/backups`)
