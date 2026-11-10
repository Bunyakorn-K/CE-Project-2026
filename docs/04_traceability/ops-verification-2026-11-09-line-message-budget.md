# Staying inside 300 LINE messages a month

**Date:** 2026-11-09
**Files:** `apps/api/src/alert-budget.ts`, `apps/api/src/alert-engine.ts`,
`apps/api/src/bot/{adapter,line-adapter,index}.ts`
**Status: implemented and tested; the first production sweep under the new floor
is the check that it behaves.**

## The constraint, in numbers

A LINE Official Account on the free plan can **push 300 messages a month**. What
this deployment was doing:

| source | rate | per month |
|---|---|---|
| gas alerts, 2 channels, hourly | 48/day | **1,440** |
| every AI chat answer (push) | per question | unbounded |

1,440 is nearly five times the allowance, and the failure mode is the worst one
available: the API starts answering 429/400, the alert row is marked `failed`, and
a safety notification stops arriving while the dashboard still looks healthy.

## Lever 1 — chat answers are free (reply, not push)

LINE charges nothing for a **reply** to a message the user just sent; it charges
for a **push**. The bot pushed every answer, so each question cost a message.

`PlatformAdapter.sendText` now takes an optional `replyToken`, and `LineAdapter`
uses `replyMessage` when it has one, falling back to `pushMessage` if LINE rejects
the token. The fallback matters: reply tokens expire in about a minute and are
single-use, and the LLM + tool loop can outlast that — losing the answer would be
worse than spending one message.

The webhook already received `replyToken` on every message event; it was simply
not carried through. Now it is, for the answer, the no-access notice and the error
notice alike.

**Effect:** chat costs 0 messages in the normal case, and 1 only when an answer
takes longer than the reply window.

## Lever 2 — alerts re-notify on a floor, and stop at a cap

| setting | before | now | why |
|---|---|---|---|
| re-notify floor | 1 hour | **12 hours** (`ALERT_RENOTIFY_HOURS`) | 2 channels × 2/day = 4/day = **120/month**, which fits |
| monthly cap | none | **200** (`ALERT_MONTHLY_BUDGET`) | 100 below LINE's 300, absorbing the fact that LINE's billing month is not ours to read |
| when the cap is hit | — | `suppressedBudget` in the sweep summary + an `alert.suppressed_budget` audit row | an alert not sent for budget is a fact someone must see, not a silence |

The count is read from `alert_notification` (`status = 'sent'` and
`delivered_at` inside the UTC month) rather than from a counter column, so it
cannot drift from what LINE actually accepted after a crash or a redeploy.

The budget is checked **after** the cooldown, so an alert is never counted twice,
and a suppressed alert is recorded rather than dropped.

## What this costs, stated plainly

- A gas decline that persists is now re-notified every 12 hours instead of every
  hour. If the shop wants faster escalation, `ALERT_RENOTIFY_HOURS=6` gives
  240/month for two channels — still inside the cap, with less room for chat.
- Acknowledging one alert still only silences that alert id (the id carries the
  hour), but with a 12-hour floor the next notification is at most two a day per
  channel, so the button is no longer the only way to stop the noise.
- The cap is a hard stop, not a queue: alerts suppressed at the cap are **not**
  delivered later. That is deliberate — a stale gas warning delivered the next
  morning is worse than none — but it means the cap should be set with the
  worst case in mind, not the average.

## Not done, and worth considering

- **A daily digest.** One message a day listing every active warning would let the
  floor go back to 1 hour for the first notification and still stay inside 300.
  It needs a scheduled job and a template; it is the obvious next step if 12 hours
  proves too slow.
- **Per-recipient budgeting.** The cap counts messages, not recipients. With three
  owners, one alert is three messages; the current numbers assume one or two.

## Verification

- `alert-budget.test.ts` (6): month boundary, only delivered rows counted, cap
  arithmetic, env parsing including nonsense values, and the 12-hour default.
- `alert-engine.test.ts` (+2): a repeat is held for twelve hours and released
  after; a spent budget suppresses the send, records `suppressedBudget: 1` and
  writes the audit row.
- `line-adapter.test.ts` (5): reply used when a token exists, push on rejection,
  push without a token, no-op without a client, and the flex altText cap.
- `bot.test.ts` (+1): the reply token reaches the adapter.
- Suite: 585 API / 316 web / 117 ETL.

**Not yet verified in production:** the first sweep after this deploy should show
`suppressedBudget: 0` and a `cooldown` count instead of a send for the second
channel within twelve hours. That is the observation to make, not an assumption.
