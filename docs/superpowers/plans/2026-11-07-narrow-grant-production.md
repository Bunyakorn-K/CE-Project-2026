# Narrow-Grant Production Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove production branch scoping, zero-grant denial, and revenue redaction using a dedicated single-branch technician account and a safe cleanup path.

**Architecture:** Use the existing `POST /api/admin/grants` endpoint to create one scoped technician grant, use the existing `POST /api/admin/grants/:id/revoke` endpoint to remove it, and run a signed-in browser smoke test against the public application. No production schema, query, or client-code change is required unless the smoke test exposes a real defect.

**Tech Stack:** TypeScript, Hono, Better Auth session via browser, Playwright, existing API admin-grant routes, existing analytics scope middleware.

**Spec:** `AGENTS.md` §Current implementation (single-branch grant paragraph), `docs/03_data_contracts/data_contracts.md`, `apps/api/src/analytics/scope.ts`, `apps/web/src/lib/admin-grant.ts`.

## Global Constraints

- Do not reuse the production owner's password.
- Create one dedicated test account and one `technician` grant for one known branch.
- Keep the account identifier and branch name in local task state, never in code, secrets, or public logs.
- Fix no application code until a production defect is reproduced in the browser.
- Verify that every forbidden request fails before the ClickHouse executor or upstream data is reached.
- Buzzwords do not substitute for an authenticated browser session: unit tests alone cannot close this caveat.

## Review Focus

- **Tenant-wide fallback:** verify that a missing or empty branch never widens a technician grant into tenant-wide scope.
- **Out-of-scope hidden data:** verify that a browser from another branch cannot see another branch's machines or usage rows.
- **Revenue redaction:** verify the technician sees no revenue KPI and no revenue trend values, not merely an absent button.
- **Cleanup failure:** verify the dedicated account has no active grants before calling this complete; an orphan grant would silently remain a production security risk.
- **API/body attribution:** verify that an out-of-scope 403 is attributed to the caller, not the reporting warehouse.

---

### Task 1: Lock the production verification fixture plan

**Files:**
- Create: `docs/04_traceability/ops-verification-2026-11-07-narrow-grant-production.md` locally and leave unstaged outside the repository until the smoke test ends.

**Interfaces:**
- Consumes: production `/api/me`, `/api/admin/grants`, and `/api/admin/grants/:id/revoke`.
- Produces: a task record containing `branchId`, `accountEmail`, `grantId`, and timestamps of create, test, and revoke.

- [ ] **Step 1: Choose fixture values outside the repository**

Use a throwaway email address, record only the opaque active grant identifier in process state, and choose the production branch whose 24/7 schedule is already provisioned.

- [ ] **Step 2: Verify the API supports the exact route pair**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/admin/grants
```

Expected: `401` without authentication.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/api/admin/grants/:id/revoke
```

Expected: `401` without authentication.

- [ ] **Step 3: Record the intended smoke assertions locally**

Record these six assertions before creating the account:

1. Out-of-scope branch request returns 403 and no warehouse rows.
2. In-scope dashboard renders only the selected branch.
3. Zero-grant dashboard renders no tenant data.
4. Technician revenue KPI is absent or marked unavailable.
5. Technician revenue trend values are absent.
6. Revocation then a second visit returns no tenant data.

- [ ] **Step 4: Confirm the fixture is ready**

Verify the branch identifier, email, and branch name are recorded in the local task record and that the branch has real usage rows in the selected date window.

### Task 2: Create and test the dedicated technician grant

**Files:**
- Modify only the local task record from Task 1.

**Interfaces:**
- `POST /api/admin/grants` accepts `{ email, role: "technician", branchId }`.
- `POST /api/admin/grants/:id/revoke` revokes the created `grantId`.
- Browser session proves `GET /api/me` returns exactly the single selected branch.

- [ ] **Step 1: Create the grant as the production owner**

```bash
curl -s -b owner-session.jar -X POST http://127.0.0.1:8787/api/admin/grants \
  -H 'Content-Type: application/json' \
  -d '{"email":"<throwaway-email>","role":"technician","branchId":"<branch-id>"}'
```

Expected: one active grant and an opaque `grantId` recorded in the task record.

- [ ] **Step 2: Sign in as the technician in a browser**

Use that dedicated session to load `/dashboard` and observe only the selected branch and its machines.

- [ ] **Step 3: Test out-of-scope access**

Request a different branch URL and verify a 403 `BRANCH_FORBIDDEN` response or equivalent browser denial, with no other branch data rendered.

- [ ] **Step 4: Test revenue redaction**

Inspect the dashboard KPI section and trend chart. Expected: revenue is unavailable and no revenue values appear in the DOM.

- [ ] **Step 5: Capture the smoke result**

Record HTTP status, response codes, visible branches, and whether ClickHouse was queried for forbidden paths.

- [ ] **Step 6: Revoke the grant immediately**

```bash
curl -s -b owner-session.jar -X POST http://127.0.0.1:8787/api/admin/grants/<grantId>/revoke
```

Expected: the grant appears revoked. Load `/dashboard` again with the technician session and verify no tenant data.

### Task 3: Update the handoff and promote the caveat only after cleanup

**Files:**
- Modify: `docs/04_traceability/ops-verification-2026-11-07-narrow-grant-production.md`
- Modify: `docs/04_traceability/ops-verification-2026-11-06-verification-caveats-audit.md`

**Interfaces:**
- Production status may change only after Task 2's active grant count is zero.

- [ ] **Step 1: Write the evidence record**

Include grant creation, branch, test timestamp, six assertions, revocation timestamp, and a link to the Playwright evidence.

- [ ] **Step 2: Update the caveat README**

Change the narrow-grant row from "Needs single-branch account creation" to "Production-verified" only if all six assertions passed and cleanup is complete.

- [ ] **Step 3: Commit**

```bash
git add docs/04_traceability/ops-verification-2026-11-07-narrow-grant-production.md \
  docs/04_traceability/ops-verification-2026-11-06-verification-caveats-audit.md
git commit -m "docs(ops): record narrow-grant production verification"
```
