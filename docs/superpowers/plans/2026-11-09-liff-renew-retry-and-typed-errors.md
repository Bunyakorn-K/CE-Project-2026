# Typed LIFF exchange failures and a bounded renew retry

> **Status 2026-11-09: Tasks 1–4 done in `main`; Task 5 partly blocked.**
> 20 tests added (web 283 → 303); `pnpm build`, `test` and `check` green under
> Node 24.21.0. Five mutations each fail the test that names them.
> Task 5 Step 1 could not run: this emulator is a Play-store **production** image,
> so `adb root` is refused and the device clock cannot be moved. CDP virtual time
> was tried instead and is **not** a substitute — it skews every origin, and
> LINE's own login page dies with "Uncaught" before our token is ever judged.
> Task 5 Step 2 was measured afterwards on the same device: the ordinary
> one-press sign-in still reaches `/dashboard` with no renewal spent.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rejected or rate-limited LIFF exchange should recover **once, on its
own**, when that can help — and stop, with an honest screen, when it cannot.
Today every 401 is treated as one thing ("stale"), the user is asked to press a
button that re-runs the same failing exchange, and a device whose clock makes
every fresh token look expired loops forever with a human in the middle.

**Source of the idea:** `Meepain-group/iris-project` → `apps/liff` (read 2026-11-09):
`src/lib/liff-client.ts:118-135` (`ExchangeErrorCode`), `src/components/liff-provider.tsx:169-183`
(retry counter + `liff.logout()`/`login()` recovery), `:220-241` (terminal screen
with `liff.closeWindow()`). Two things there are **not** to be copied — see
"Rejected borrowings".

**Spec (ours):** `apps/web/src/lib/components/liff-gate.tsx` —
`LiffExchangeError` `:92-96`, `isRejectedTokenError` `:104-106`,
`exchangeIdentity` `:108-128`, boot effect `:340-420`;
`apps/web/src/liff.ts` — `planLineSignIn` `:213-222`, `isIdTokenExpired` `:174-182`,
`signInWithLiff` `:242-263`; `apps/api/src/index.ts:157-193` (exchange and the
codes it emits), `:1069-1094` (`liffError` status/code mapping);
`apps/web/src/lib/api-errors.ts:57-59` (existing Thai copy for those codes).

## What the server actually says

`POST /api/auth/liff/exchange` distinguishes causes already, and the client
currently throws that away into a status number:

| Case | Status | Code |
|---|---|---|
| LINE rejected the ID token (expired / malformed / other channel) | 401 | `LIFF_VERIFICATION_FAILED`, or `LIFF_TOKEN_REJECTED` from the catch-all |
| LINE or the channel config is down | 502 / 503 | `LIFF_VERIFICATION_FAILED` |
| Too many exchanges from this caller | 429 + `Retry-After` | `RATE_LIMITED` |
| LINE identity known but access not approved | 403 | `ACCESS_PENDING` (already handled — gate sets the pending card) |
| Grants revoked / never granted | 403 | `ACCESS_NOT_GRANTED` |
| No ID token in the request | 400 | `INVALID_LIFF_TOKEN` |

So "401" is not one fact: `expired` is the only branch where logging out and
fetching a fresh token helps, `429` needs waiting, and `502/503` is not the
user's problem to retry.

## Design

### 1. Classify once, as a pure function

```ts
export type ExchangeFailure =
  | { kind: "expired" }                       // 401 LIFF_TOKEN_REJECTED | LIFF_VERIFICATION_FAILED
  | { kind: "rate_limited"; retryAfterSeconds: number | null }  // 429
  | { kind: "server" }                        // 502 | 503
  | { kind: "pending" }                       // 403 ACCESS_PENDING
  | { kind: "not_granted" }                   // 403 ACCESS_NOT_GRANTED
  | { kind: "network" }                       // fetch threw before a response
  | { kind: "other"; status: number };

export function classifyExchangeFailure(input: { status?: number; code?: string | null; retryAfterSeconds?: number | null }): ExchangeFailure
```

`exchangeIdentity` keeps throwing, but the error carries `{ status, code }`
parsed from the body it already reads — no new request, no new dependency.

### 2. Bound the recovery, and branch on the client

```ts
export type Recovery = "renew-external" | "renew-in-client" | "terminal" | "pending" | "denied" | "rate-limited" | "error" | "blocked";

export function decideRecovery(input: {
  failure: ExchangeFailure;
  attempts: number;        // from sessionStorage
  signedOut: boolean;      // the liff_signed_out marker
  isInClient: boolean;     // liff.isInClient()
}): Recovery
```

| Input | Result | Why |
|---|---|---|
| `signedOut` | `blocked` — render the sign-in form, **never** auto-recover | 2026-11-08 defect: any automatic re-auth after a sign-out signs the user back in |
| `expired`, attempts < 3, external browser | `renew-external` → `liff.logout()` + `liff.login({redirectUri})` | the documented recovery outside LINE |
| `expired`, attempts < 3, in LINE | `renew-in-client` → `liff.logout()` + `location.reload()` | **`liff.login()` cannot be used in a LIFF browser**; the reload re-inits and LINE re-issues |
| `expired`, attempts ≥ 3 | `terminal` | a clock skew that makes every fresh token "expired" must not loop |
| `rate_limited` | `rate-limited`, with the `Retry-After` seconds in the copy | waiting is the only fix; a renew would burn another exchange and hit 429 again |
| `pending` / `not_granted` | the existing cards | unchanged behaviour, now reached by code instead of by status |
| `server` / `network` / `other` | `error` card, no auto-retry | retrying a 502 or a dropped network is noise |

Counter: `sessionStorage["liff_renew_attempt"]` (per tab, per origin). Increment
**before** navigating; reset the moment a session is obtained (`/api/me` 200 after
an exchange, or a successful `probeSession`). `MAX_RENEW_ATTEMPTS = 3` — the same
bound iris uses, and the reason it exists there: LINE's clock and the device's can
diverge enough that every newly-issued token still arrives expired.

### 3. Terminal screen instead of a retry that cannot work

Thai title/body explaining that LINE keeps issuing a token this device considers
expired, a single action — `liff.isInClient() ? liff.closeWindow() : window.close()`
— and the existing "เข้าสู่ระบบด้วยอีเมลแทน" escape kept as a link, so a user with
a broken LINE path is not trapped. `liff.closeWindow()` is only meaningful inside
LINE; `window.close()` only succeeds for a tab the script opened, hence best-effort
in a try/catch, as iris does at `:77-94`.

## Rejected borrowings

- **A cached rejected `initPromise`.** `apps/liff/src/lib/liff-client.ts:30-38`
  assigns `liff.init(...).catch(err => { throw err })` to a module-level promise:
  one failed init poisons every later call for the life of the page. Ours memoises
  the failure separately (`initError`) and can retry; keep that.
- **Unconditional `liff.login()` in recovery.** `liff-provider.tsx:177` calls it
  without asking whether the app is inside LINE, where the docs say `liff.login()`
  cannot be used. Ours branches on `isInClient`.
- **A 7-day client-side session JWT.** Their session lives in `sessionStorage` and
  is revalidated per request; ours is an httpOnly cookie the server revokes. Moving
  to theirs would trade a server-revocable session for a bearer token — a different
  security posture, not an improvement. Out of scope here.
- **A silent first retry with no user-visible difference.** If the retry succeeds
  the user sees nothing (good); if it fails three times they must be told why, and
  "เซสชัน LINE หมดอายุแล้ว" is the wrong sentence for a clock skew.

## Global Constraints

- The signed-out marker outranks every automatic path. `decideRecovery` returning
  anything that triggers a login while `liff_signed_out === "1"` re-opens the
  2026-11-08 defect; the guard is the first branch and gets its own test.
- `/privacy` and `/terms` must never be redirected or replaced by a recovery
  screen. They are ungated today (`UNGATED_PATHS`, `liff-gate.tsx:147`) and stay so.
- No recovery may run a second exchange while one is in flight, and none may fire
  on a page that is already navigating.
- The pending and denied cards keep their current copy; only their trigger changes
  from status to code.
- No test may seed a session. Production-shaped verification uses the emulator.

---

### Task 1: Classification and the decision, with tests

**Files:**
- Modify: `apps/web/src/lib/components/liff-gate.tsx` (export only)
- Create: `apps/web/src/lib/liff-recovery.test.ts`

- [x] **Step 1: Write the failing tests**

`apps/web` tests are pure-node; no jsdom. Cover:

```ts
// classify: 401 LIFF_TOKEN_REJECTED → expired; 401 LIFF_VERIFICATION_FAILED → expired
// classify: 429 + retry-after 12 → rate_limited{12}; 429 without → {null}
// classify: 502/503 → server; fetch throw → network; 403 ACCESS_PENDING → pending
// classify: 403 ACCESS_NOT_GRANTED → not_granted; 500 → other{500}
// decide: signedOut with an expired token → "blocked" (never renew)
// decide: expired, 0 and 2 attempts, external → "renew-external"; in-client → "renew-in-client"
// decide: expired, 3 attempts → "terminal"
// decide: rate_limited → "rate-limited"; server/network → "error"; pending/denied unchanged
```

- [x] **Step 2: Run and record the failure** — missing exports, not a typo.

- [x] **Step 3: Implement** both functions in `liff-gate.tsx`, with the table above
  as the doc comment. `exchangeIdentity` parses `error.code` from the body it
  already reads and throws `LiffExchangeError` carrying `{ status, code }`;
  `isRejectedTokenError` becomes `classifyExchangeFailure` at its call site.

### Task 2: The counter and the wiring

**Files:**
- Modify: `apps/web/src/lib/components/liff-gate.tsx`
- Modify: `apps/web/src/liff.ts`

- [x] **Step 1: Counter helpers beside the existing guards**

`readRenewAttempts()`, `bumpRenewAttempts()`, `resetRenewAttempts()` in `liff.ts`,
next to `loginSentRecently` (`:51-65`) and the signed-out marker (`:67-130`), same
try/catch style: storage that throws must degrade to "0 attempts", never to a throw.

- [x] **Step 2: Wire the effect**

Replace the `if (action === "stale")` branch (`liff-gate.tsx:398-405`) and the
catch block's `isRejectedTokenError` branch (`:358-368`) with one path:
`classifyExchangeFailure` → `decideRecovery` → act. Every `renew-*` bumps the
counter **before** navigating. Success anywhere (`probeSession` true, or the
exchange 200) resets it.

- [x] **Step 3: Terminal screen**

New `state === "terminal"`, rendered with the close-window action and the email
escape. Keep `decideGate` total: add `"terminal"` to `GateDecision`, with tests
that a signed-out browser never reaches it (it must render the form, not a card).

- [x] **Step 4: `planLineSignIn` stays the press path**

A manual press keeps its current behaviour (`renew` → `logout()` + `login()`), but
`renew-in-client` inside a LIFF browser becomes `logout()` + `reload()`. That is a
third case for `planLineSignIn`, so give it an `isInClient` input and test all six
combinations.

### Task 3: Prove each guard bites

- [x] **Step 1: Mutate, one at a time**

| Mutation | Must fail |
|---|---|
| drop the `signedOut` branch from `decideRecovery` | the "never renew after sign-out" case |
| treat `attempts >= MAX` as retryable | the terminal case |
| classify 429 as `expired` | the rate-limited case |
| call `liff.login()` regardless of `isInClient` | the in-client renew case |
| reset the counter on mount instead of on success | the counter-reset ordering test |

- [x] **Step 2: Report the mapping**, and say which mutation only bites when the
  code is already correct (those are tautologies, not evidence).

### Task 4: Local gates

```bash
pnpm build && pnpm test && pnpm check
```

Build first — `spa-bundle.test.ts` reads the real `apps/web/dist` and fails without
it. Run under the pinned Node (`.nvmrc` = 24) or the API suite dies on
`ERR_DLOPEN_FAILED` from `better-sqlite3`'s ABI, which is an environment fault and
reads like a code fault.

### Task 5: Production-shaped check on the emulator (best effort)

- [ ] **Step 1: BLOCKED — the device clock cannot be moved on this image.** On the
  emulator, set the device clock two hours ahead (`adb shell su 0 date` on a
  debuggable image, or disable auto-time first), open the app, and watch the renew
  path: the first exchange should be rejected 401, the client should renew **once**,
  then stop at the terminal screen by attempt 3 instead of looping.
  **Not run, and the reason matters:** `adb root` is refused on a Play-store
  production image, so the guest clock cannot be set. `Emulation.setVirtualTimePolicy`
  does move `Date.now()` (+2.00 h measured), but it moves it for *every* origin in the
  renderer: LINE's login page then fails with an uncaught error and the token is never
  judged. The bound is therefore covered by the unit tests and the mutation, not by a
  device run.

- [x] **Step 2: Restore the clock**, reopen, and confirm an ordinary sign-in still
  lands on `/dashboard` in one press — the fix must not cost the ordinary path.

- [x] **Step 3: Record what it did and did not prove.** A clock skew simulates an
  expired token; it does not reproduce LINE issuing a genuinely expired one. Say so.

## Out of scope

- Server-side session revocation (already in place: `POST /api/auth/liff/logout`).
- The LIFF-browser press leg, still blocked by LINE's generic error —
  `docs/04_traceability/ops-verification-2026-11-09-liff-browser-leg.md`.
- Moving LaundryTwin to a bearer session JWT (see "Rejected borrowings").
