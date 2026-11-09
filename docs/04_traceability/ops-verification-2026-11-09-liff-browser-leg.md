# The real LIFF browser: sign-out holds, one press gets back in (2026-11-09)

**Status: PASS, measured inside LINE's own browser** —
`jp.naver.line.android/com.linecorp.liff.impl.LiffActivity`, LINE `26.17.1`,
emulator `ltline` (Pixel 6, Android 15), against
`laundrytwin:deploy-4fb470d-20261109`.

This closes the two legs that had never been exercised: **signing out inside a
LIFF browser, and signing back in with one press.** That client matters most,
because there `liff.init()` logs the user in automatically and `liff.login()`
cannot be called at all — so a sign-out that does not hold would be undone by
nothing more than reopening the app.

## Correction: the earlier BLOCKED run was a bad URL, not LINE

An earlier version of this file blamed LINE: after the first open, every later
open showed *"An unknown error occurred. Please try again later."* The cause was
**a hand-typed LIFF ID**. The test URLs used `2011592166-uToRdTwT`; the app's ID —
and the one baked into the deployed bundle — is `2011592166-uToRdTwS`. One
character:

```
https://liff.line.me/2011592166-uToRdTwS  → 200 text/html
https://liff.line.me/2011592166-uToRdTwT  → 404 {"message":"LIFF app '2011592166-uToRdTwT' was not found."}
```

LINE was right both times. The single open that did render (12:06) is consistent
with LINE's own "See recently used services" entry — the popup shown on that open
— resolving a cached app instead of the malformed URL. That mechanism is an
inference, not a measurement; every later attempt was a fresh resolve of the bad
ID and failed, and the Android-answer `query-activities` still resolved the
*host* to `LiffActivity`, which is why the typo survived the one check that was
run against it.

**Rule this leaves behind: never retype an identifier into a test URL.** Read it
from the artifact under test — `grep` the served entry chunk for the ID prefix
returns exactly one value. From the client's screen, a one-character URL error and
a deleted app look identical, and the difference decides whether you report a
blocked test or a product outage.

## Measured, in order (`2026-11-09`, UTC)

| Step | When | Result |
|---|---|---|
| Open `https://liff.line.me/2011592166-uToRdTwS` in LINE | `05:49Z` | LIFF browser opened; app rendered **signed in** (header carried `ออกจากระบบ`), dashboard with real data (`ดึงเมื่อ 9 พ.ย. 12:49`) |
| Press `ออกจากระบบ` | `05:50:13Z` | **sign-in form** — `เข้าสู่ระบบด้วย LINE`, the email form, both legal links |
| Close and reopen the LIFF URL (the case where `liff.init()` logs in by itself) | `05:50:29Z` | **still the sign-in form** — the `liff_signed_out` marker suppressed the exchange, so a shared machine stays signed out |
| Tap `นโยบายความเป็นส่วนตัว` | `05:51:17Z` | stayed on `/privacy` (`นโยบายความเป็นส่วนตัว (Privacy Policy)`) |
| Tap `ข้อกำหนดการใช้งาน` | `05:51:56Z` | stayed on `/terms` (`ข้อกำหนดการใช้งาน (Terms of Use)`) |
| Press `เข้าสู่ระบบด้วย LINE` **once** | `05:52:16Z` | `/dashboard`, signed in, `ดึงเมื่อ 9 พ.ย. 12:52` — no second press |

Evidence: `uiautomator` text dumps at each step — 105 text nodes for the signed-in
dashboard, 15 for the sign-in form — plus screenshots. The sign-in form's node
count is the load-bearing one: the dashboard's header (`ออกจากระบบ`, `เปิดเมนู`)
is absent from it.

## What this establishes, and what it does not

- ✅ Sign-out inside a real LIFF browser lands on the sign-in form and **stays**
  there across a reopen, where the SDK would otherwise log the user back in.
- ✅ The legal documents are reachable from the sign-in surface and do not
  redirect, in that same client.
- ✅ One press signs back in: the marker is cleared by the press, not by a load.
- ❌ **No status code.** LINE's WebView exposes no devtools socket, so `/api/me`
  cannot be read from inside it; this claim rests on the rendered surface. The
  same marker behaviour *was* measured as a `401` in Android Chrome —
  `ops-verification-2026-11-09-sign-out-holds.md`.
- ❌ Not a second device, and not iOS.
- ❌ Not a genuinely expired token; the renew bound is unit-tested, and its device
  run stays blocked because the emulator is a Play-store production image with no
  `adb root` (`docs/superpowers/plans/2026-11-09-liff-renew-retry-and-typed-errors.md`).

## Cleanup

Nothing was created, deleted or edited in the LINE Developers Console. The
emulator keeps the owner's own LINE login; the session left after the final press
is the ordinary LINE-sourced account the app creates for itself. No secret was
printed, stored or committed.
