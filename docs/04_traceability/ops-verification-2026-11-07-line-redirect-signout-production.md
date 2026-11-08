# LINE redirect and sign-out production verification — 2026-11-07 plan

**Status: PARTIAL — Task 1 passed, Task 2 failed. The caveat is NOT promoted.**
Sign-out revokes the session and then the app signs the user straight back in
from the still-cached LINE token, so `GET /api/me` answers **200** after the
button the plan calls success. A separate code plan is open for the defect
(`docs/superpowers/plans/2026-11-08-sign-out-reauthentication-defect.md`); no
code was changed while measuring.

## Method, and the correction it forced

The plan's global constraint said "the real LINE client is required; a desktop
browser cannot exercise `liff.login()` redirect". Both halves were measured and
both are wrong in a way that changes which client can run this test:

| Claim | Measurement |
|---|---|
| Desktop browser cannot exercise `liff.login()` | **False.** One press in desktop Chromium fired `liff.login()` and landed on `https://access.line.me/oauth2/v2.1/login?…` with `redirect_uri=https%3A%2F%2Flaundrytwin.duckdns.org%3Fliff.state%3D%252Flogin`, `app_id=2011592166-uToRdTwS`, `liff_sdk_version=2.29.1`. |
| The LINE client can perform the press | **False for LINE for PC.** LINE documents the LINE URL scheme — including `https://liff.line.me/{liffId}` — as *"isn't supported in LINE for PC (macOS, Windows)"*, and the LIFF recommended-environment table lists only iOS and Android for the LINE app. |
| `liff.login()` runs inside a LIFF browser | **False.** The SDK logs in during `liff.init()`; the docs state `liff.login()` cannot be used in a LIFF browser. The redirect leg therefore only exists in an external browser or LINE's in-app browser opened on the raw URL. |

So the plan's named client (LINE for PC) is the one client that cannot reach the
code path, and the client it excluded (an external browser) is the documented
one. This run used the closest honest substitute to a phone: **a real LINE
client on Android**, in an emulator, driving the production URL in Android
Chrome — real LINE account, real `liff.login()` redirect, no seeded or stubbed
session anywhere. It is not the LIFF-browser press and is not recorded as one.

**Environment**

| Item | Value |
|---|---|
| Device | Android emulator `ltline` (Pixel 6, Android 15 / API 35, `google_apis_playstore`, `arm64-v8a`), `emulator-5554` |
| LINE | LINE app `26.17.1`, signed in by the owner on the device |
| Browser | Chrome `124.0.6367.219`, driven over `adb` taps + the Chrome DevTools Protocol (`Runtime.evaluate`, `Network.*`) |
| LINE SDK | LIFF `2.29.1`; LIFF ID `2011592166-uToRdTwS` (read from the OAuth request, so the deployed bundle carries a real ID) |
| Account | LINE user, `source: "liff"`, name `ด.ช.นน`; owner-level nav (`ผู้ดูแล`) rendered |
| No secrets | No password, token or SMS code was typed, read or transcribed by the agent. The owner signed in on the device. |

## Task 1 — one press must reach `/dashboard`: PASS

| Assertion | Measured |
|---|---|
| Start signed-out at `/login` | `2026-11-08T18:18:10Z` (`01:18 +07`), `https://laundrytwin.duckdns.org/login`, **zero cookies**, LIFF context only |
| Press once | one `adb shell input tap` at `2026-11-08T18:18:14Z`; `liff_login_sent` written once, at `1794161894390` = `18:18:14.390Z` — the press, not a boot-time login |
| Landed on `/dashboard` | visible page `https://laundrytwin.duckdns.org/dashboard`, one press, no second press |
| Session | `GET /api/me` → **200** `application/json`, body `{"user":{…,"email":"line-U284d77fa27c1bf0be58fe91ad71618d3@liff.local"},"source":"liff","grants":[…]} ` |
| KPI rendered | `แถว usage ที่ได้: 818`, `508 จาก 517 แถว (98%) ไม่มีรหัสเซสชัน`, window `3 พ.ย. 2569 — 9 พ.ย. 2569`, `ดึงเมื่อ 9 พ.ย. 01:18`, branches `about you.wash & dry แม่โจ้ - ตลาดโซนเหลือง` / `- หลิ่งมื่น`, badge `แหล่งข้อมูล: ClickHouse` |
| `/privacy` | `18:19:13Z` → stayed on `…/privacy`, heading `นโยบายความเป็นส่วนตัว (Privacy Policy)` |
| `/terms` | `18:19:18Z` → stayed on `…/terms`, heading `ข้อกำหนดการใช้งาน (Terms of Use)` |
| Return to product | `…/dashboard`, signed in |

A second tab existed mid-flow (the SDK's auth leg) and was left on `/login`
while holding a live session. Reloading it navigated to `/dashboard` — i.e. the
post-sign-in rule (`decideAfterSignIn`) resolves a signed-in `/login` on a fresh
load. It is recorded because "a browser can sit on `/login` with a valid
session" is the exact state later assertions must not mistake for evidence.

## Task 2 — sign-out must revoke the session: FAIL

The button is `.signout-button` (`aria-label="ออกจากระบบ"`, icon-only at 412 px),
pressed once at `2026-11-08T18:22:34Z`. Every `/api/` request the page made in
the following 18 s, captured over CDP `Network.*` (timestamps relative to the
press):

```
2.04s REQ POST /api/auth/sign-out      ct=application/json   → 200 application/json
2.04s REQ POST /api/auth/liff/logout   ct=-                  → 200 application/json
2.62s REQ POST /api/auth/liff/exchange ct=application/json   → 200 application/json   ← the app re-authenticates
2.88s REQ GET  /api/me                                      → 200 application/json
3.03s REQ GET  /api/report/dashboard?from=2026-11-03&to=2026-11-09 → 200
3.03s REQ GET  /api/report/summary?from=2026-11-03&to=2026-11-09   → 200
3.27s RES 200 (both), 3.14s /api/report/branches → 200
```

| Assertion | Measured |
|---|---|
| Press → `/login` | navigated, then returned to `/dashboard` within ~0.6 s |
| `POST /api/auth/sign-out` carries `content-type: application/json` | **yes** (captured) — the 415 defect stays fixed |
| Both revocations succeed | yes, `200` each |
| `GET /api/me` afterwards | **200** — not the 401 the plan names as success |
| Final visible route | `/dashboard` (screenshot, `18:22:53Z`) |

**Revocation itself works; the app undoes it.** Isolating the halves:

- `POST /api/auth/liff/logout` alone at `18:21:37Z` → `GET /api/me` = **401**.
- `POST /api/auth/sign-out` alone at `18:21:22Z` → `GET /api/me` = **200**. That
  is by design — a LIFF session is not a Better Auth session
  (`apps/api/src/index.ts:195-213` revokes `laundrytwin_liff_session`;
  `:217-231` accepts either). It also means Better Auth's sign-out alone is a
  silent no-op with a `200`, so the `liff/logout` call is load-bearing.
- Cookies **and** origin storage cleared over CDP at `18:23:03Z` → `GET /api/me`
  = **401**, `localStorage` empty. The server had no session left to honour.

So the 200 is not a stale cookie and not a cache: it is a **new** session.

### Mechanism

1. `handleSignOut` (`apps/web/src/lib/components/app-shell.tsx:64-82`) fires
   both revocations, calls `signOut()`, then `window.location.replace("/login")`
   — deliberately a full page load, to remount the gate.
2. `LiffGate`'s mount effect (`apps/web/src/lib/components/liff-gate.tsx:306-357`)
   runs on **every** path, including `/login`, and if `liff.isLoggedIn()` and the
   ID token is not expired it calls `exchangeIdentity` → `POST
   /api/auth/liff/exchange`. There is no state that says "the user just signed
   out", and the LIFF store is not cleared, so the token is still there.
3. A new session cookie is minted, `/api/me` answers 200, `decideAfterSignIn`
   sends the browser to `/dashboard`.

The sign-out's own full page load is what re-authenticates. This is the same
class as the 2026-10-02 defect AGENTS.md records ("a sign-out that does not hold
is worse than no sign-out button"), reached by a different mechanism: that fix
made the revocation land, and the gate now re-mints the session a fraction of a
second later. On a shared machine the UI still tells someone the session ended
while the product stays open on its own.

## What this record does NOT establish

- **Not the LIFF-browser press.** The flow ran in Android Chrome with the LINE
  app installed. `liff.login()` is not usable inside a real LIFF browser, so a
  phone press inside LINE would exercise a *different* leg. Calling this
  "verified in the real LINE client" would repeat the exact overclaim AGENTS.md
  warns about for the 2026-10-01 check.
- **Not an in-app-browser press.** LINE's in-app browser on the raw URL is the
  other documented route and was not walked.
- **Not many devices.** One Android 15 image, one Chrome build, one LINE build.
- **Not the fix.** The defect is recorded, not repaired; no application code was
  edited during this run.
- **Not the wider caveat.** Narrow-grant scoping, zero-grant denial and revenue
  redaction remain unit-only (see the 2026-11-06 audit).

## Cleanup

- Cookies and origin storage cleared at `18:23:03Z` via CDP
  (`Network.clearBrowserCookies`, `Storage.clearDataForOrigin`); `/api/me` → 401
  afterwards, `localStorage` empty. No test account was created — the session was
  an ordinary LINE-sourced account created by the app itself.
- The emulator still holds the owner's LINE login (the owner's own account, on
  the owner's machine). It was left running only so the defect fix can be
  re-verified on the same device; wipe or uninstall is the owner's call.
- No secret was printed, stored or committed. The OAuth URLs quoted above carry
  the public LIFF ID and the return path, not a token; the user's LINE ID is
  recorded only as the already-public `U…` identifier the session body returns.

## Verification baseline captured alongside (unauthenticated, no account needed)

| Probe | Result (`2026-11-08T16:32Z`) |
|---|---|
| `GET /health` | 200 `application/json` `{"ok":true,"reportingConfigured":false,"demoMode":false}` |
| `GET /login`, `/privacy`, `/terms` | 200 `text/html; charset=utf-8` |
| `GET /api/me` (no cookie) | 401 |
| `POST /api/auth/sign-out` no content-type | **415** `UNSUPPORTED_MEDIA_TYPE` |
| same POST with `content-type: application/json` | **200** `{"success":true}` |
| Served entry chunk | `assets/index-BGIBi0Rb.js`; sign-out chunk `assets/_authenticated-JyGb6MHP.js` contains `headers:{"content-type":"application/json"}`, `body:"{}"`, `credentials:"include"`, `replace("/login")` |
