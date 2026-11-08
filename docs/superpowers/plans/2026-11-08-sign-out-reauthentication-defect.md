# Sign-out is undone by the gate's automatic LINE exchange

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ออกจากระบบ` hold. After a sign-out, no page load may mint a new session from the cached LINE token, and `GET /api/me` must answer `401` until the user presses "เข้าสู่ระบบด้วย LINE" again.

**Measured defect (production, 2026-11-08, real LINE app on Android):**
`docs/04_traceability/ops-verification-2026-11-07-line-redirect-signout-production.md`.
Network trace after one sign-out press: `sign-out` 200 and `liff/logout` 200, then
`POST /api/auth/liff/exchange` **200 at +0.58 s**, `GET /api/me` **200**, browser
back on `/dashboard`. Revocation works; the client re-authenticates 0.6 s later.
This is the "a sign-out that does not hold" class AGENTS.md already records, via a
new mechanism: the fix that made revocation land is now followed by an automatic
re-exchange.

**Architecture:** The gate (`apps/web/src/lib/components/liff-gate.tsx:306-357`)
exchanges a live LINE ID token for a session on **every** path, with no state
saying the user just signed out, and `handleSignOut`
(`apps/web/src/lib/components/app-shell.tsx:64-82`) ends in
`window.location.replace("/login")` — a full page load that remounts exactly that
effect. The fix is a sign-out marker the gate honours, plus dropping the cached
LINE token so the exchange has nothing to trade.

**Tech Stack:** TypeScript, React, LIFF SDK (`@line/liff`), Better Auth + the
custom `laundrytwin_liff_session` cookie, Vitest, Playwright.

**Spec:** `apps/web/src/lib/components/liff-gate.tsx`,
`apps/web/src/lib/components/app-shell.tsx`, `apps/web/src/liff.ts`,
`apps/api/src/index.ts:195-231` (`liff/logout`, principal middleware).

## Global Constraints

- **The failure direction is not symmetric.** A missing or unreadable marker must
  keep the current auto-exchange, because suppressing it for a first-time visitor
  breaks sign-in for everyone. Only a marker this build recognises may suppress it.
- Do not gate sign-in on a timer alone. An expiring marker is acceptable as a
  backstop, but the primary clear is the explicit press.
- `/privacy` and `/terms` stay ungated; nothing here may redirect a visitor away
  from a legal document.
- The session is `laundrytwin_liff_session`; Better Auth's `/api/auth/sign-out`
  returns 200 for it and revokes nothing. Keep calling `/api/auth/liff/logout`.
- Never seed or stub a session to test this; every production run goes through the
  real LINE client.

## Review Focus

- **First press still signs in.** The whole risk of this change is a marker that
  outlives its sign-out, so the sign-in path must clear it before it needs it.
- **No exchange after sign-out.** Asserted on the request, not the URL — the
  defect's whole nature is that the URL looks right for ~0.6 s.
- **The cached token is gone.** If the marker is the only guard, one cleared entry
  restores the defect; `liff.logout()` is the second lock.
- **A signed-in visitor is still sent to `/dashboard`** (`decideAfterSignIn`) —
  the 2026-10-02 fix must not regress.

---

### Task 1: Reproduce with a failing spec

**Files:**
- Create: `apps/web/e2e/signout-holds.pw.ts`
- Modify: `apps/web/src/lib/components/liff-gate.test.ts`

- [ ] **Step 1: Write the pure-decision test first (RED)**

Assert the decision in isolation, before any wiring exists:

```ts
// shouldAutoExchange: absent marker → true (today's behaviour must survive)
// shouldAutoExchange: marker = signed out → false
// shouldAutoExchange: unrecognised marker value → true (never guess "signed out")
```

- [ ] **Step 2: Write the Playwright spec against the built bundle**

Stub `/api/*` like `stale-liff-session.pw.ts` does, drive the shell, press
`ออกจากระบบ`, and assert **the requests**, not the URL:

- `POST /api/auth/sign-out` carried `content-type: application/json`
- no `POST /api/auth/liff/exchange` occurs after it
- `GET /api/me` answered `401` and the visible surface is the sign-in form

- [ ] **Step 3: Verify the spec fails today**

Run it against the current bundle and record the failure. It must fail on the
exchange request appearing, not on a missing selector. A spec that passes here is
testing nothing.

### Task 2: Make the marker real

**Files:**
- Modify: `apps/web/src/lib/components/app-shell.tsx`
- Modify: `apps/web/src/lib/components/liff-gate.tsx`
- Modify: `apps/web/src/liff.ts`

- [ ] **Step 1: Write the marker on sign-out, before the navigation**

In `handleSignOut`, immediately before `window.location.replace("/login")`, set
a localStorage entry (e.g. `liff_signed_out_at`) inside a try/catch — storage can
be unavailable, and a sign-out must never throw because of it. Then call
`liff.logout()` so the cached token is dropped as well.

- [ ] **Step 2: Honour it in the gate**

Read the marker before the `exchangeIdentity` call. When it is present, set
`sessionUsable` from `probeSession()` and render the sign-in surface instead of
exchanging. Keep the existing stale-token and rejected-token branches untouched.

- [ ] **Step 3: Clear it on an explicit press, not on page load**

Clear it in `resetLiffLoginGuard()`'s call sites (the login button and the
stale-session card). Do **not** clear it merely because the app mounted, or the
next load re-arms the defect.

- [ ] **Step 4: Run the unit tests, then the spec**

`pnpm --filter @laundrytwin/web test` and the new spec, then mutate each guard —
drop the marker read, invert the default, clear it on mount — and confirm the
spec fails for each. Report which mutation fails which assertion.

### Task 3: Verify in production, then record it

**Files:**
- Create: `docs/04_traceability/ops-verification-<date>-sign-out-holds.md`

- [ ] **Step 1: Deploy through the runbook gate**

Backup (SQLite via `db.backup()`, never `cp`), build `linux/amd64`, pin
`APP_IMAGE` in `/opt/laundrytwin/.env`, `docker compose up -d app`, rollback
target recorded. Caddy is untouched — the port does not change.

- [ ] **Step 2: Re-run the measured harness**

Android emulator `ltline` (Pixel 6, API 35), Chrome over CDP, real LINE login.
Capture the `Network.*` trace for the sign-out cycle and require: both revokes
`200`, **no** `/api/auth/liff/exchange`, `GET /api/me` **401**, visible surface the
sign-in form.

- [ ] **Step 3: Prove the sign-in leg still works**

One press after the marker → exchange → `/dashboard`. If this needs a second
press, the marker is being cleared too late and the fix is wrong.

- [ ] **Step 4: Record it**

Write the ops record with the trace, timestamps, chunk hashes, and an explicit
"what this does NOT establish". Promote the sign-out leg in
`ops-verification-2026-11-06-verification-caveats-audit.md` **only if** every
assertion passed.

## Out of scope

- The LIFF-browser press (a real LIFF browser cannot run `liff.login()`), which
  remains unverified by construction.
- A real expired LINE token, still unreproducible: the SDK validates its cached
  token against LINE's servers and discards a seeded store.
