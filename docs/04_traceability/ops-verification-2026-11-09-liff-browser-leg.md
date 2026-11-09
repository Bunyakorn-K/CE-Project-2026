# The real LIFF browser: auto sign-in verified, the press BLOCKED (2026-11-09)

**Status: PARTIAL.** In LINE's own LIFF browser (`jp.naver.line.android/
com.linecorp.liff.impl.LiffActivity`) the app opens **already signed in, with no
press** — the `liff.init()` → exchange leg, measured. The press and sign-out
legs inside that same browser could not be exercised: after the first successful
open, LINE answered every further open with its generic *"An unknown error
occurred. Please try again later."*, including from a genuine chat link and
after a full device reboot. No evidence is claimed for those two legs.

Device: emulator `ltline` (Pixel 6, Android 15), LINE app `26.17.1`, production
`laundrytwin:deploy-4fb470d-20261109`. Method: `adb` intents + `uiautomator dump`
+ `adb exec-out screencap` (a LIFF browser is LINE's WebView — it exposes no
devtools socket, so there is no network trace and no `/api/me` status here; the
evidence is what the screen said).

## Verified: the LIFF browser signs in without a press

| Step | Measured (`2026-11-09 12:06 +07`) |
|---|---|
| Handler | `cmd package query-activities -a VIEW -d https://liff.line.me/2011592166-uToRdTwT` → **`jp.naver.line.android/com.linecorp.liff.impl.LiffActivity`** (priority `0x308000`), plus Chrome as a second resolver |
| Open | explicit VIEW intent → `mCurrentFocus=…/com.linecorp.liff.impl.LiffActivity` |
| Screen | LINE's in-app browser chrome: title **`LaundryTwin · Operations workspace`**, domain **`laundrytwin.duckdns.org`**, close button |
| Session | **already signed in** — the page header shows the logout control and the menu button, not the sign-in form |
| Content | `ภาพรวมการดำเนินงาน`, `แหล่งข้อมูล: ClickHouse`, `3 พ.ย. 2569 — 9 พ.ย. 2569`, `ดึงเมื่อ 9 พ.ย. 12:06`, **`แถว usage ที่ได้: 847`**, `528 จาก 537 แถว (98%) ไม่มีรหัสเซสชัน`, `537 รอบ จาก 24 เครื่อง`, `ยอดชำระสำเร็จ ฿33,700.00` |
| Accessibility tree | 117 text nodes, i.e. the rendered DOM, not a blank shell |

No press of "เข้าสู่ระบบด้วย LINE" was made: the only tap after opening was at
`(540,1550)`, to dismiss LINE's own *"See recently used services at a glance"*
popup. The sign-in button sits at y≈1082 on this layout. So the session was
created by the gate's automatic exchange on `liff.init()` — which is exactly what
LINE documents for a LIFF browser, where `liff.login()` cannot be called at all.

That is the useful half of this leg: the client that real users actually open
does sign them in without a press, and it renders real ClickHouse data.

## BLOCKED: the press and the sign-out inside the LIFF browser

What was tried, in order, each returning the same dialog
(*"An unknown error occurred. Please try again later."*, no code, no URL, one
`OK` button):

1. `https://liff.line.me/2011592166-uToRdTwT/privacy` and `…/terms` — the first
   failures. Whether the sub-path form is unsupported for this app is **not
   established**; LINE's message carries no detail.
2. The root LIFF URL again, by intent. Same dialog.
3. Force-stopped LINE and reopened. Same dialog.
4. Started LINE from its launcher icon (its main process alive, `pidof` non-empty)
   and then opened the LIFF URL. Same dialog.
5. The authentic path: sent the LIFF URL to **Keep Memo** (message delivered
   `12:11`) and tapped the link bubble in the chat. Same dialog.
6. Rebooted the device and opened the URL again. Same dialog — so it is not a
   stuck WebView or a warm-cache artefact.

**Why this stops here.** Clearing LINE's LIFF state means clearing LINE's app
data (`pm clear`), which signs the owner out of LINE and would need their
credentials and their consent to reinstate. That is a human decision, not an
agent step, and nothing about it is needed to prove the app itself works —
which the run above already did.

## What this record establishes, and what it does not

- ✅ The real LIFF browser loads the production app and **auto-signs-in** via the
  exchange leg, with the authenticated dashboard's real numbers on screen.
- ❌ Not the press: the sign-out-then-sign-in cycle inside the LIFF browser is
  unmeasured. Note that inside a LIFF browser `liff.login()` is unusable, so the
  "press" there is specifically the `exchange` plan after a sign-out.
- ❌ Not `/privacy` or `/terms` inside LINE (the sub-path open failed; the
  legal-document rule is production-verified in Android Chrome instead — see
  `ops-verification-2026-11-07-line-redirect-signout-production.md`).
- ❌ Not a status code: no `/api/me` status is observable in LINE's WebView, so
  the signed-in claim rests on the rendered page, not on a 200.

**To close it:** on a phone where LINE is logged in, open
`https://liff.line.me/2011592166-uToRdTwT` from a chat, press `ออกจากระบบ`, and
report whether the sign-in form stays after a reopen and whether one press
returns to the dashboard. That is one human, one app, two presses — and it is
the only remaining assertion for this client.
