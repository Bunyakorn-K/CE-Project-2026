# LINE delivery works: two real messages accepted by LINE, and the cooldown holds

**Date:** 2026-11-09
**Image:** `laundrytwin:deploy-1a5f728-20261109` (restarted onto the new credentials,
not rebuilt — the code did not change)
**Status: verified in production. The notification half of R05 is real; the IRIS
half is still unsourced.**

## What was missing, and where it came from

Every prior sweep recorded `error = "LINE_CHANNEL_ACCESS_TOKEN is not configured"`
with `delivered_at: null`, and `docker inspect … | awk` reported the token's
**length as 0**. The same was true in `/opt/laundrytwin-rollback/env.bak-20261109-predeploy`
and in `/opt/backups/pre-deploy-20260929/config/laundrytwin/.env` — so LINE push
messaging had never been configured in this deployment; only LIFF login was.

The owner supplied the Messaging API channel's token and secret. They were placed
at `/opt/laundrytwin/.env` **on the Mac**, which is not the file the server reads
(`/opt/laundrytwin/.env` on `10.10.0.117`, mtime unchanged at 09:36 UTC). The two
values were transferred over the SSH channel into the host file with a script that
reads them from stdin, inserts them by key, keeps the file at mode 600 and never
puts a value on an argv or in a log. Neither value appears in this record, the
repository, or any command output — only their lengths.

```text
LINE_CHANNEL_ACCESS_TOKEN len=172
LINE_CHANNEL_SECRET       len=32
```

An `awk -F=` length check had earlier reported 171 because a channel access token
can contain `=`, and `-F=` splits on all of them. The transport was right; the
measurement was not.

## Pre-flight: the token is valid, and it is the right bot

```text
GET https://api.line.me/v2/bot/info  → 200
bot: {userId: U84751233744ec200051a34393af40e31, basicId: @307cpoja,
      displayName: LaundryTwin, chatMode: bot}
```

That is a probe, not a send: it proves the credential without messaging anyone.

## The send

After `docker rm -f` + `compose up -d app` (the env file is only read at container
create, so a restart is the deploy here), the container's own environment reports
`LINE_CHANNEL_ACCESS_TOKEN` at length 172 and `GET /health` → 200.

One sweep, `POST /api/internal/alerts/sweep` at 13:16:45 UTC:

```json
{"lineConfigured": true,
 "gas": {"state": "evaluated", "alertable": 2,
         "summary": {"scanned": 2, "recipients": 2, "sent": 2, "deduplicated": 0,
                     "cooldown": 0, "noRecipients": 0, "failed": 0, "acknowledged": 0},
         "window": {"from": "2026-11-09T07:16:45.921Z", "to": "2026-11-09T13:16:45.921Z"}},
 "channels": [
   {"channel": "gas_run_a_pressure", "trend": "declining",
    "reason": "declining:edgeRate=-3.6697psi/h,drop=20psi,slope=-2.7048psi/h"},
   {"channel": "gas_run_b_pressure", "trend": "declining",
    "reason": "declining:edgeRate=-2.6168psi/h,drop=14psi,slope=-3.1042psi/h"},
   {"channel": "changeover_filter_pressure", "trend": "steady",
    "reason": "not_declining:edgeRate=-0.1829psi/h,drop=1psi,slope=-0.0206psi/h"}]}
```

Two rows written, both `sent`, both with `delivered_at` set and `error: null`:

| `iris_alert_id` | status | delivered_at (epoch ms) |
|---|---|---|
| `gas:gas_run_b_pressure:declining:2026-11-09T13` | **sent** | 1794230205921 |
| `gas:gas_run_a_pressure:declining:2026-11-09T13` | **sent** | 1794230205921 |

Body as stored: `🔔 LaundryTwin แจ้งเตือน (WARNING)` / `แนวโน้มแรงดันแก๊สลดลงต่อเน…`.
The four earlier rows keep `failed` with the token error, which is the honest
history of the same rule before the credential existed.

## The cooldown holds

A second sweep run immediately after:

```json
{"alertable": 2, "recipients": 0, "sent": 0, "cooldown": 2, "failed": 0}
```

Row counts unchanged (`sent: 2, failed: 4`) — the same two alerts were recognised
and suppressed, not re-sent. That is the "with cooldowns" half of R05 measured, not
assumed.

## What this does and does not close

- **Delivered**: a scheduled, machine-triggered alert reached a real LINE user
  twice, with the evidence and the window attached to the row.
- **Not delivered, still**: anything sourced from IRIS. `iris.state: unavailable`
  is in the same response, because production sets no `IRIS_READ_BASE_URL`. The
  mechanism is proven; half of its inputs are not.
- **Inbound signature validation now works**, tested with three payloads against
  the live container:

  ```text
  POST /webhooks/line  (no signature)            → 401
  POST /webhooks/line  (x-line-signature: AAAA…) → 401
  POST /webhooks/line  (HMAC-SHA256 of the body   → 200 {"ok":true}
                        base64, events: [])
  ```

  So a forged event is refused and a correctly signed one is accepted. What that
  does *not* prove is a real LINE delivery of an inbound event through the bot's
  handler — that needs an actual message from a user, and the empty-events payload
  exercises the signature gate and the ack only.
- **The Mac copy of the credentials** at `/opt/laundrytwin/.env` is `root:wheel`
  mode 644 and is not read by anything. It should be removed or made 600; the
  server has its own copy.

## Card v2: four facts, a button, and the page behind it (`469a751`)

The first card carried nine rows. The reader was asked to parse all of them on a
phone to find the two that decide anything, so v2 keeps four — channel, pressure,
gating rate, machine state — at 16px bold against 13px labels under a 22px title,
and moves the rest behind a button.

The button is a LIFF deep link, `https://liff.line.me/2011592166-uToRdTwS/alerts/<id>`,
built from `LIFF_ID` and omitted when that variable is unset, because a button
that goes nowhere is worse than no button. Alert ids contain colons, so the path
segment is percent-encoded; the router decodes it.

That link opens `/alerts/<id>`, backed by `GET /api/alerts/:id`, which returns the
alert **as it was sent** from `alert_notification` — every evidence row in
decision order, the ambient's age, coverage and NULL minutes, the message body
verbatim, the raw evidence JSON, and an acknowledge button. Authorisation is
narrow on purpose: a recipient of that alert, or branch access to the branch it
names; otherwise 403, and an unknown id is 404 rather than an empty body.

Measured after deploy (`deploy-469a751-20261109`, healthy):

```text
GET /alerts/gas%3A…%3A2026-11-09T16   200   (SPA shell index-C6cTnvQf.js)
GET /api/alerts/gas%3A…%3A2026-11-09T16   401   (no session — route exists, auth enforced)
POST https://api.line.me/v2/bot/message/validate/push   200 {}   (the exact card, with the button)
```

Delivery, unassisted, from the schedule:

| run | alerts | status | delivered_at |
|---|---|---|---|
| `scheduled__2026-11-09T15:20:00` | `gas:…run_a:declining:2026-11-09T15`, `gas:…run_b:declining:2026-11-09T15` | sent | 1794237602049 (15:20:02Z) |
| `scheduled__2026-11-09T16:25:00` | `gas:…run_a:declining:2026-11-09T16`, `gas:…run_b:declining:2026-11-09T16` | sent | 1794241501541 (16:25:01Z) |

Notification rows at 16:36 UTC: `sent: 8, failed: 4`. The four failures are the
pre-credential history and have not changed.

Not verified here: that the delivered message rendered as a card rather than the
text fallback (the row stores text either way), and the authenticated rendering of
the detail page — opening it from the button is the check, and it needs the
owner's own session.

## The card, delivered by the scheduler (`cfb12ed`)

The alert is a Flex Message now: a coloured header by severity, one labelled row
per fact, the gating rate marked as the gate and the fitted slope kept beside it,
and the ambient's age disclosed because the temperature feed runs 24 hours behind.
Before this, the text quoted ClickHouse's raw average as `68.57309385055319 °C`
and showed only the slope, so a reader could not reproduce the verdict.

Verification, in the order it happened:

1. **LINE accepted the schema.** The payload was not hand-written — it was built
   by `buildAlertFlex` from the stored evidence of a real alert and posted to
   `POST https://api.line.me/v2/bot/message/validate/push`, which validates
   without sending: `http=200 {}`.
2. **The scheduler sent it.** No button was pressed. `scheduled__2026-11-09T14:20:00+00:00`
   ran green and wrote two rows:

   | `iris_alert_id` | status | delivered_at |
   |---|---|---|
   | `gas:gas_run_b_pressure:declining:2026-11-09T14` | **sent** | 1794234000848 (14:20:00.848Z) |
   | `gas:gas_run_a_pressure:declining:2026-11-09T14` | **sent** | 1794234000848 |

   Notification table afterwards: `sent: 4, failed: 4` — the four failures are the
   pre-credential history, unchanged.
3. **The cooldown still holds.** The 14:15 run was inside the hour that began at
   13:16 and reported `cooldown: 2, sent: 0`; 14:20 was the first run allowed to
   send, and did.

What this record cannot claim on its own: that the delivered message was the card
rather than the text fallback. The database stores the text body either way. The
evidence for the card is the deployed image (`deploy-cfb12ed-20261109`), the tests
that make the engine prefer `sendFlex` when the adapter has it, LINE's validation
of that exact payload, and the message as the owner sees it.

## One scheduled run failed, and why

`scheduled__2026-11-09T13:15:00+00:00` **failed** with

```text
alert sweep endpoint unreachable at http://app:8787/api/internal/alerts/sweep:
[Errno -2] Name or service not known
```

That is the restart itself: the app container was removed and recreated to pick up
the new environment, so for the few seconds the old name was gone, Docker's DNS
answered nothing for `app`. The next scheduled run, `…T13:20:00`, was **success**,
and the notification table still held exactly `sent: 2, failed: 4` — the 13:20
sweep was inside the cooldown and sent nothing. A recreate is not a free
operation for a 5-minute schedule; it costs at most one run, and this one did.

## Provenance

Owner placed the credentials and said so in chat; the token was validated against
LINE before use; the message content, the row, and the cooldown are all the
application's own output. No value from either credential appears anywhere in this
record.
