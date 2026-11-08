# Sign-out must hold: stop the gate re-authenticating after revocation

> **Status 2026-11-08: Tasks 1–4 done in `main`, Task 5–6 not started.**
> 15 tests added (web 268 → 283); build, test and check green under Node 24.21.0;
> marker and ordering confirmed in the built chunk. Nothing is deployed, so
> production still re-authenticates after a sign-out.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After `ออกจากระบบ`, no page load may mint a new session from the cached
LINE token. `GET /api/me` must answer `401`, and the visible surface must be the
sign-in form, until the user presses "เข้าสู่ระบบด้วย LINE" again.

**Measured defect (production, 2026-11-08, real LINE app on Android):**
`docs/04_traceability/ops-verification-2026-11-07-line-redirect-signout-production.md`.
Trace after one press: `sign-out` 200 and `liff/logout` 200, then
`POST /api/auth/liff/exchange` **200 at +0.58 s**, `GET /api/me` **200**, browser
back on `/dashboard`. Revocation works; the client re-authenticates itself 0.6 s
later. AGENTS.md already names this class — "a sign-out that does not hold is
worse than no sign-out button" — reached here by a new mechanism.

**Spec:** `apps/web/src/lib/components/liff-gate.tsx:306-357` (mount effect),
`apps/web/src/lib/components/app-shell.tsx:64-82` (`handleSignOut`),
`apps/web/src/liff.ts:51-79` (login guard), `apps/web/src/routes/login.tsx:47-74`
(the press), `apps/api/src/index.ts:195-231` (`liff/logout`, principal
middleware).

## Root cause, in three facts

1. `handleSignOut` fires both revocations and then performs a **full page load**
   to `/login` (`window.location.replace("/login")`, `app-shell.tsx:81`).
2. `LiffGate`'s mount effect runs on **every** path, including `/login`
   (`liff-gate.tsx:301-306`), and exchanges a live ID token for a session
   whenever `liff.isLoggedIn()` and the token is not expired (`:328-357`).
3. Nothing records that the user asked to be signed out, and the LIFF store is
   untouched, so the token is still there when that load runs.

The fix's own full page load is what signs the user back in. Both revocations are
correct and must stay; the missing piece is a signed-out state the gate honours.

## Design

**A marker, written on sign-out, read by the gate, cleared only by an explicit
press.** Three small pieces:

| Piece | Where | Rule |
|---|---|---|
| `markLiffSignedOut()` / `isLiffSignedOut()` / `clearLiffSignedOut()` | `apps/web/src/liff.ts`, beside the existing `LOGIN_SENT_KEY` guard | localStorage key `liff_signed_out`; `isLiffSignedOut()` is `=== "1"`. Absent, unreadable or unrecognised ⇒ `false`, i.e. **auto-exchange stays on** |
| `decideMountExchange({ isLoggedIn, idToken, signedOut, now })` | `liff-gate.tsx`, exported pure | `!isLoggedIn` → `idle`; `signedOut` → `idle`; expired token → `stale`; else `exchange` |
| `clearLiffSignedOut()` | first line of `signInWithLiff` (`liff.ts:242`) | that function is the only path both presses go through |

The gate's effect then uses the pure function; the missing-ID-token throw stays
where it is, before the decision.

### Why not the obvious alternatives

- **Skip the exchange on `/login`.** That path must exchange: the 2026-10-02 fix
  works *because* LINE returns the user to `/login` and the gate performs a fresh
  exchange there (`decideAfterSignIn`'s comment, `liff-gate.tsx:250-290`).
  Skipping it re-opens the double press.
- **A marker with a TTL.** After expiry a plain reload silently re-signs the user
  in — the defect returns in the one state nobody looks at. The only clear is the
  explicit press.
- **A server-side tombstone keyed by the LINE user id.** Needs the identity at
  sign-out and would block sign-in from every device until cleared. Too big for a
  sign-out button.
- **A Playwright spec for the behaviour.** It cannot distinguish the fix: with
  `*.line.me` aborted the SDK never yields a token, so *no* exchange happens and
  the spec passes against today's broken build — the "green because of the layer
  above it" trap this repository has hit three times. There is also no
  component-mounting test rig in `apps/web` (no jsdom, no Testing Library), so a
  mounted-gate test would mean adding a test framework to fix one branch. The
  unit tests pin the decision; the production harness in Task 6 is the
  integration proof.

## Decision points for the owner (settle before Task 2)

1. **Scope of the marker.** Default: uniform — after a sign-out no browser
   auto-exchanges until a press, a real LIFF browser included. The narrower
   alternative (`liff.isInClient()` keeps ambient auto-login inside LINE) leaves
   the hole open in the client LINE users actually live in, so if it is chosen it
   must be recorded as a known limitation, not glossed.
2. **Whether to also call `liff.logout()` on sign-out.** It drops the cached
   token, so the next press performs a real `liff.login()` redirect instead of a
   silent exchange: more correct, one extra redirect. Defence in depth — if it is
   skipped, the marker is the only lock and one cleared localStorage entry
   restores the defect.

## Global Constraints

- **The failure direction is not symmetric.** An absent or unreadable marker must
  keep today's auto-exchange; suppressing it for a first-time visitor breaks
  sign-in for everyone. Only the exact recognised value may suppress it.
- `POST /api/auth/sign-out` returns 200 for a LIFF session and revokes nothing —
  the `liff/logout` call is load-bearing and must not be "simplified" away.
- `/login`, `/privacy`, `/terms` stay ungated; nothing here may redirect a visitor
  away from a legal document.
- The 2026-10-02 guarantee must not regress: a signed-in visitor at `/login` is
  still sent to `/dashboard`, and the LINE redirect still lands on `/dashboard` in
  one press.
- No test may seed or stub a session; production runs go through the real LINE
  client.

---

### Task 1: The marker and the pure decision

**Files:**
- Modify: `apps/web/src/liff.ts`
- Modify: `apps/web/src/lib/components/liff-gate.tsx` (export the decision first)
- Create: `apps/web/src/lib/signed-out.test.ts`

- [x] **Step 1: Write the failing tests first**

`apps/web` runs vitest in the node environment with no `localStorage`, so stub it
(`vi.stubGlobal`) with a Map-backed fake, the way `app-shell.test.ts` stubs
`fetch`. Each case names the failure it prevents:

```ts
// round-trip: mark → isLiffSignedOut() true → clear → false
// "0", "", "true", "signed-out" → false   (only "1" suppresses; anything else keeps sign-in working)
// localStorage throwing (private mode) → mark/read/clear all survive without throwing
// decideMountExchange: not logged in          → "idle"
// decideMountExchange: logged in, no marker   → "exchange"   (today's behaviour must survive)
// decideMountExchange: logged in, marker set  → "idle"       (the fix)
// decideMountExchange: signed out AND expired → "idle", not "stale" (a sign-out is not a stale session)
```

- [x] **Step 2: Run them and record the failure**

`pnpm --filter @laundrytwin/web test` — they must fail on the missing export, not
on a typo. The behavioural red already exists and is the recorded production
trace; do not claim a unit test "reproduced" the defect.

- [x] **Step 3: Implement the marker**

In `liff.ts`, beside the login guard, with the same defensive style already used
by `loginSentRecently` (storage can be absent or throw):

```ts
const SIGNED_OUT_KEY = "liff_signed_out";
export function markLiffSignedOut(): void { try { localStorage.setItem(SIGNED_OUT_KEY, "1"); } catch {} }
export function isLiffSignedOut(): boolean { try { return localStorage.getItem(SIGNED_OUT_KEY) === "1"; } catch { return false; } }
export function clearLiffSignedOut(): void { try { localStorage.removeItem(SIGNED_OUT_KEY); } catch {} }
```

- [x] **Step 4: Implement the decision**

In `liff-gate.tsx`, exported, with a comment on why `signedOut` outranks `stale`
(a signed-out browser has a perfectly good token — that is exactly the point):

```ts
export type MountExchange = "idle" | "stale" | "exchange";
export function decideMountExchange(input: {
  isLoggedIn: boolean;
  idToken: string | null | undefined;
  signedOut: boolean;
  now?: number;
}): MountExchange
```

Keep the effect's existing early return on `!liff.isLoggedIn()` (it avoids a
pointless request on every visit); the `isLoggedIn` input exists so the decision
is total and the early return cannot be dropped unnoticed.

### Task 2: Wire it

**Files:**
- Modify: `apps/web/src/lib/components/app-shell.tsx`
- Modify: `apps/web/src/lib/components/liff-gate.tsx`
- Modify: `apps/web/src/liff.ts`
- Modify: `apps/web/src/lib/components/app-shell.test.ts`

- [x] **Step 1: Mark the sign-out before the navigation**

In `handleSignOut`, after the `Promise.allSettled` and **before**
`window.location.replace("/login")`: `markLiffSignedOut()`. It must not depend on
any request succeeding. If the owner chose `liff.logout()`, call it here too —
guarded, non-throwing, and never a reason to skip the marker.

- [x] **Step 2: Honour it in the gate**

Replace the inline `isIdTokenExpired` branch with `decideMountExchange`. On
`idle`: `setSessionUsable(await probeSession(controller.signal)); setState("ready")`.
On `stale` and `exchange`: unchanged. Keep the existing `cancelled`/`controller`
guards — that effect already has them and dropping one leaks a setState after
unmount.

- [x] **Step 3: Clear it only on a press**

First line of `signInWithLiff` (`liff.ts:242`): `clearLiffSignedOut()`. Nothing
else clears it — in particular nothing on mount, which would re-arm the defect on
the very next load.

- [x] **Step 4: Pin the ordering in `app-shell.test.ts`**

Stub `fetch`, `localStorage` and `window.location.replace`; call the handler;
assert the marker exists **at the moment** `replace` is called. The ordering is
the fix — a marker written after the navigation never lands.

### Task 3: Prove each guard bites

**Files:** none — this is verification.

- [x] **Step 1: Mutate one at a time and re-run**

| Mutation | Must fail |
|---|---|
| drop the `signedOut` branch from `decideMountExchange` | the `idle` case |
| invert the default so an absent marker suppresses | the `exchange` case |
| accept any stored truthy value | the `"0"/""/"true"` cases |
| clear the marker on mount instead of on press | the app-shell ordering test |
| `isLiffSignedOut()` throwing when storage is unavailable | the private-mode case |

- [x] **Step 2: Report the mapping**

State which assertion failed for each mutation. A mutation that only bites when
the code is already correct is a tautology — say so instead of counting it.

### Task 4: Local gates

- [x] **Step 1: Build before test** — `spa-bundle.test.ts` reads the real
  `apps/web/dist` and **fails** rather than skips without it. Order matters.

```bash
pnpm build && pnpm test && pnpm check
```

- [x] **Step 2: Read the shipped bytes** — `liff_signed_out` and the decision must
  appear in a built chunk (`apps/web/dist/assets/*.js`). A fix that is not in the
  chunk is not a fix; note that route code is lazily imported, so follow the
  router manifest rather than grepping `index.html`.

### Task 5: Deploy through the runbook gate

- [ ] **Step 1: The runbook, not a shortcut.** SQLite backup via `db.backup()` and
  verified (`integrity_check`, table and row count) — a file copy captures a 4 KB
  stub and zero rows. One image (`linux/amd64`) carrying both halves;
  `APP_IMAGE` pinned in `/opt/laundrytwin/.env`; rollback target recorded; Caddy
  untouched because the port does not change.

- [ ] **Step 2: Public status matches the baseline.** `/health` 200 JSON,
  `/login`, `/privacy`, `/terms` 200 HTML, `/api/me` 401 unauthenticated, app
  container `0` restarts.

### Task 6: Re-run the production harness and record it

**Files:**
- Create: `docs/04_traceability/ops-verification-<date>-sign-out-holds.md`

- [ ] **Step 1: Same device, same method.** Emulator `ltline` (Pixel 6, API 35),
  Android Chrome over CDP (`adb forward tcp:9222 localabstract:chrome_devtools_remote`,
  a small Node `WebSocket` client on `Network.*`), real LINE login. This is the
  harness that produced the defect trace; reusing it keeps the before/after
  comparable.

- [ ] **Step 2: Require all four, in one trace**

```
POST /api/auth/sign-out      ct=application/json   → 200
POST /api/auth/liff/logout                         → 200
(no POST /api/auth/liff/exchange at any point)
GET  /api/me                                       → 401
visible surface: sign-in form
```

- [ ] **Step 3: Prove the sign-in leg still works.** One press → exchange →
  `/dashboard`; `/privacy` still does not redirect. Two presses means the marker
  is cleared too late and the fix is wrong.

- [ ] **Step 4: Record, then decide promotion.** Write the ops record with the
  trace, timestamps, chunk hashes and an explicit "what this does NOT establish".
  Promote the sign-out leg in
  `ops-verification-2026-11-06-verification-caveats-audit.md` **only if** every
  assertion above passed. The LIFF-browser press and a real expired token stay
  unverified either way.

## Out of scope

- The LIFF-browser press: a real LIFF browser cannot call `liff.login()`, so that
  leg is unreachable by construction and must stay labelled as such.
- A real expired LINE token: the SDK validates its cached token against LINE's
  servers and discards a seeded store.
- Any change to the revocations themselves — measured working (`liff/logout` alone
  → 401; cookies and storage cleared → 401).
