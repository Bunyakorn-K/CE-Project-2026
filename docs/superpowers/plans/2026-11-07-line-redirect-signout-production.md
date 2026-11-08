# LINE Redirect and Sign-Out Production Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that a LINE SDK redirect returns to `/dashboard`, that sign-out revokes the session, and that `/privacy` and `/terms` are never redirected after sign-in.

**Architecture:** Use the real LINE client to perform one redirect sign-in, navigate to the two legal documents, then perform one sign-out cycle and attempt a second dashboard load. The existing unit and Playwright coverage already pins the pure decision functions, so this plan is production acceptance only. Any bug found opens a new code plan rather than being fixed silently here.

**Tech Stack:** TypeScript, React, LINE LIFF, Better Auth session via browser, Playwright for existing evidence.

**Spec:** `apps/web/src/liff.ts`, `apps/web/src/lib/components/liff-gate.tsx`, `apps/web/src/lib/components/app-shell.tsx`, `apps/web/e2e/stale-liff-session.pw.ts`.

## Global Constraints

- The real LINE client is required; a desktop browser cannot exercise `liff.login()` redirect.
- Do not seed or stub a session to imitate the redirect — the production result must come from the LINE client.
- Treat a successful sign-in that stays on `/login` as a failure; a second press is not a workaround.
- `/privacy` and `/terms` are legal documents; a signed-in visitor navigating to them must remain on the document.
- Sign-out success is measured by `/api/me` returning `401`, not by URL navigation alone.

## Review Focus

- **First-press navigation:** verify that a single LINE press lands on `/dashboard`, because only the redirect leg exercises the bug.
- **Legal document stability:** verify that a later navigation to `/privacy` or `/terms` never redirects to `/dashboard`.
- **Token replay after sign-out:** verify that the next `/api/me` call returns `401`, because URL-only navigation previously masked a non-revoked session.
- **Stale-session gate:** verify that a version of the site that blocks on an expired cached ID token is not mistaken for evidence that the real LINE client failed.
- **Cleanup:** verify that no staging session cookie or test account remains after the cycle.

---

### Task 1: Run the real LINE redirect smoke test

**Files:**
- Create: `docs/04_traceability/ops-verification-2026-11-07-line-redirect-signout-production.md`

**Interfaces:**
- Production `https://laundrytwin.duckdns.org/login` and `/dashboard`.
- LINE LIFF client available on the test device.

- [ ] **Step 1: Begin from a signed-out `/login` in the LINE client**

- [ ] **Step 2: Press "เข้าสู่ระบบด้วย LINE" once**

Expect: immediate navigation to `/dashboard` without a second press.

- [ ] **Step 3: Record the result**

Record the final URL, time of press, and whether the dashboard KPI section rendered.

Expected: `GET /api/me` returns `200` and the dashboard renders.

- [ ] **Step 4: Navigate to `/privacy` and `/terms` in the same session**

Expected: both pages load and remain on the legal document.

- [ ] **Step 5: Capture the smoke result**

Include URLs, timestamps, and a screenshot or DOM excerpt proving the dashboard is reached.

### Task 2: Run the sign-out revocation smoke test

**Files:**
- Modify: `docs/04_traceability/ops-verification-2026-11-07-line-redirect-signout-production.md`

**Interfaces:**
- `apps/web/src/lib/components/app-shell.tsx` sends `POST /api/auth/sign-out` with `content-type: application/json`.
- Server-side session revocation makes `GET /api/me` return `401`.

- [ ] **Step 1: Press "ออกจากระบบ"**

Expected: navigation to `/login`.

- [ ] **Step 2: Verify the request reached the API**

Inspect the network request and confirm `Content-Type: application/json`.

- [ ] **Step 3: Attempt to load `/dashboard` again without signing in**

Expected: `GET /api/me` returns `401` and the site shows the sign-in surface, not the product.

- [ ] **Step 4: Verify session revocation server-side**

Use the API status code, not URL alone, as the success criterion.

- [ ] **Step 5: Record the revocation evidence**

Record the request content-type, the `401` status, and the final visible route.

### Task 3: Update the caveat record

**Files:**
- Modify: `docs/04_traceability/ops-verification-2026-11-06-verification-caveats-audit.md`

**Interfaces:**
- Production status may change only after Tasks 1 and 2 both pass with the real LINE client.

- [ ] **Step 1: Write the production record**

Include redirect result, legal-document result, sign-out content-type, `401` result, and timestamps.

- [ ] **Step 2: Promote the caveat**

Change the LINE redirect/sign-out row to production-verified only if every assertion in Tasks 1–2 passed.

- [ ] **Step 3: Commit**

```bash
git add docs/04_traceability/ops-verification-2026-11-07-line-redirect-signout-production.md \
  docs/04_traceability/ops-verification-2026-11-06-verification-caveats-audit.md
git commit -m "docs(ops): record LINE redirect and sign-out production verification"
```
