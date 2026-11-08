# Closed Rendering Production Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the neutral closed-branch rendering in production by provisioning a temporary non-24/7 schedule for a non-operational branch, then removing it.

**Architecture:** Use the existing `dim_branch_hours` fact table and existing `branch-availability.ts` logic. Do not alter application code. Create a temporary schedule for the sandbox branch only, prove the Dashboard and Machines pages render `ปิดตามเวลาทำการ`, then delete the temporary row and prove the prior `open` behavior is restored.

**Tech Stack:** TypeScript, ClickHouse, existing `apps/api/src/report/clickhouse-report.ts`, `apps/web/src/lib/branch-availability-view.ts`, live production browser.

**Spec:** `AGENTS.md` §Status of the branch-open minimum, `docs/03_data_contracts/data_contracts.md`, `apps/api/src/report/branch-availability.ts`, `apps/web/e2e/closed-branch-honesty.pw.ts`.

## Global Constraints

- The real branch's 24/7 schedule is immutable in this plan; only the sandbox branch may carry a temporary schedule.
- `closed` means "not observable", never "assume the machines are fine"; the app must not claim machines are fine.
- Only positive evidence may render `closed`; absent, malformed, or unknown schedules must remain `unknown`.
- This is an operational test, not a code change; no application code change is authorized unless the production smoke test exposes a real defect.
- Remove the temporary row after the browser check and verify the API again exposes the pre-test state.

## Review Focus

- **Shut branch noise:** verify that a shut sandbox branch renders `ปิดตามเวลาทำการ` instead of red `ไม่พร้อมใช้งาน`.
- **Open branch with no evidence:** verify that a real branch that is open still renders machines as `ไม่พร้อมใช้งาน`.
- **Unknown schedule fallback:** verify that an absent row never falls into `closed`, because one unchanged fallback silently suppresses real faults.
- **Rollback completeness:** verify that removing the temporary row restores `unknown`, then restore the real branch remains `open`.
- **Safety copy:** verify that no UI copy claims a closed machine is healthy.

---

### Task 1: Confirm the prod schedule state before change

**Files:**
- Create: `docs/04_traceability/ops-verification-2026-11-07-closed-rendering-production.md`

**Interfaces:**
- Read-only ClickHouse access to `dim_branch_hours`.
- Produces: current `branchId` rows and `open`/`closed`/`unknown` value per branch.

- [ ] **Step 1: Query the live schedule**

```sql
SELECT branch_id, open_minute, close_minute, open_days, version
FROM dim_branch_hours FINAL
ORDER BY branch_id;
```

Expected: one 24/7 row for the real branch and no row for the sandbox branch.

- [ ] **Step 2: Query the API for the same branches**

Use the Dashboard API response and record `branchOpenState` for every machine.

- [ ] **Step 3: Identify the sandbox branch**

Confirm a branch with no usage rows exists that can carry the temporary row without affecting a real service path.

### Task 2: Insert the temporary sandbox schedule and verify API

**Files:**
- Create on VM 117 only: `/opt/backups/clickhouse/pre-closed-rendering-test-<UTC-timestamp>.sql`

**Interfaces:**
- `dim_branch_hours` columns: `branch_id`, `open_minute`, `close_minute`, `open_days`, `version`.
- `apps/api/src/report/clickhouse-report.ts` maps the row into `branchOpenState` without a server-side TTL.

- [ ] **Step 1: Save the current sandbox state**

```sql
BACKUP TABLE dim_branch_hours TO Disk('backup', 'pre-closed-rendering-test-<UTC-timestamp>');
```

Verify `system.backups.status = OK`.

- [ ] **Step 2: Insert a schedule that closes the current minute**

```sql
INSERT INTO dim_branch_hours (branch_id, open_minute, close_minute, open_days, version)
VALUES ('<sandbox-branch-id>', 0, 0, [1,2,3,4,5,6,7], 2);
```

Expected: `open_minute == close_minute` means closed for every minute.

- [ ] **Step 3: Query the API directly**

Request the sandbox branch and verify one API result contains `"branchOpenState":"closed"`.

- [ ] **Step 4: Query the real branch unchanged**

Verify the real branch remains `"branchOpenState":"open"` and none of its machines move into `closed`.

### Task 3: Verify the browser rendering

**Files:**
- Modify: `docs/04_traceability/ops-verification-2026-11-07-closed-rendering-production.md`

**Interfaces:**
- Dashboard route `/dashboard` reads `machineAvailability` from the API.
- Machines route `/machines` reads the same API shape.

- [ ] **Step 1: Load the sandbox branch in a browser**

Expected: the sandbox machines render `ปิดตามเวลาทำการ` with `status-pill--neutral`.

- [ ] **Step 2: Load the real branch in the same session**

Expected: machines still render `ไม่พร้อมใช้งาน` where freshness is unavailable, and the dashboard KPI remains unchanged.

- [ ] **Step 3: Record the evidence**

Include screenshots or DOM excerpts of `pill` text and class names, timestamps, and branch names.

### Task 4: Roll back the test schedule

**Files:**
- Modify: `docs/04_traceability/ops-verification-2026-11-07-closed-rendering-production.md`
- Modify: `docs/04_traceability/ops-verification-2026-11-06-verification-caveats-audit.md`

**Interfaces:**
- Rollback target: `system.backups` record from Task 2, Step 1.

- [ ] **Step 1: Remove the temporary row**

```sql
ALTER TABLE dim_branch_hours DELETE WHERE branch_id = '<sandbox-branch-id>' AND version = 2;
```

- [ ] **Step 2: Verify the API resolves the sandbox to `unknown`**

Query `branchOpenState` again. Expected: `unknown` for sandbox; `open` for real branch.

- [ ] **Step 3: Update the caveat record**

Promote `closed` rendering to production-verified only after rollback is confirmed.

- [ ] **Step 4: Commit**

```bash
git add docs/04_traceability/ops-verification-2026-11-07-closed-rendering-production.md \
  docs/04_traceability/ops-verification-2026-11-06-verification-caveats-audit.md
git commit -m "docs(ops): record closed rendering production verification"
```
