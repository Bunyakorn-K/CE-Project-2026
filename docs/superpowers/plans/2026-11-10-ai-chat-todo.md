# AI chat — task list

Companion to [`2026-11-10-ai-chat.md`](./2026-11-10-ai-chat.md). One line per
deliverable, ticked when it is built **and** verified. The plan holds the reasoning;
this file holds the state.

Legend: `[ ]` not started · `[x]` built and verified

## P1 — a conversation instead of a question

- [x] `chat_turn` table (schema, DDL, index on `(line_user_id, created_at)`)
- [x] `bot/memory.ts`: `appendTurn`, `recentTurns(limit=8)`, `purgeExpiredChatTurns` (30 days, same window as `chat_message`)
- [x] `llm-client.agenticAnswer` accepts prior `messages`, not only `input`
- [x] `conversation.ts` feeds the last 8 turns and asks for the current question only
- [x] `showLoadingAnimation` on receipt — adapter method, LINE implementation, called before MCP/LLM work
- [x] one-slot queue per LINE user replaces the `busy` Set (a second message waits, it is not dropped)
- [x] `max_steps` in `ai_settings` (default 4), used by the bot, editable in `/admin/ai`
- [x] tests: memory, history plumbing, queue order, loading called, settings range
- [ ] deployed and observed: follow-up question answered in context; two quick messages both answered; typing indicator seen
      — deployed `eeb5b82`; schema migrated (chat_turn + max_steps=4 verified in production); waiting on a real two-message conversation in LINE

## P2 — the bot can be talked to, not just asked

- [x] postback handler with typed payloads (`ack:<alertId>`, `branch:<id>`, `help`) — `branch:` is parsed as unknown on purpose; branch selection stays in the app
- [x] `รับทราบ` via postback writes `alert_acknowledgement`, re-checks scope server-side, replies with what changed
- [x] quick replies on the first message of a thread (ภาพรวมวันนี้ / เมื่อวาน / เครื่องที่มีปัญหา)
- [x] follow event → welcome message (carries a reply token, so free) naming what the bot can answer
- [x] `help` answer with role-appropriate examples and the menu labels, from the same definitions the rich menu uses
- [x] tests: postback scope rejection, ack idempotence, quick-reply payloads, follow handling
- [x] verified in production (`25382d2`): follow, `help` and `ack:<alert>` each accepted
      (webhook 200); the ack wrote `alert_acknowledgement` for the real LINE user with
      note "acknowledged in LINE chat" and an `alert.acknowledged` audit row

## P3 — it cannot surprise us

- [x] answer shaping: ≤ 900 characters, ≤ 2 messages, split on paragraph boundaries, never mid-word — `bot/shape.ts`; both parts in one reply, so the split is still one message
- [x] `chat_turn` records model / steps / tool_calls / latency_ms / delivered and `/admin/ai` shows today's totals, the reply/push split, this month's pushes and the limits (tokens: not yet — the client does not return them)
- [x] rate limit: 20 messages/hour/user, 300/day across users, refused in Thai with the reason — `bot/limit.ts`, counted from `chat_turn`, Bangkok day boundary
- [x] chat pushes counted against the same monthly LINE budget as alerts — `budgetState().breakdown` returns `{alerts, chat}`
- [x] `CHAT_ENABLED` switch that turns chat off without a deploy, and is reported by `/api/ai/chat/stats`
- [x] tests: shaping at the boundaries (7), limiter arithmetic (9), budget counting, switch off

### P3 evidence (production, `85bd664`)

- `GET /api/ai/chat/stats` → `{turnsToday: 7, repliesToday: 4, pushesToday: 3, pushesThisMonth: 3, limits: {hourly: 20, daily: 300, enabled: true}}`
- `GET /api/admin/alert-settings` → `used 22 = alerts 19 + chat 3`, `remaining 178`
- a real over-long answer (1,700 characters) shaped to **2 parts of 688 and 679**, `truncated: true`
  — the third block did not fit the two-message cap and was cut with a visible marker plus the
  "ask more narrowly" note. Raising `MAX_PARTS` to 3 is a one-line change if the summary matters
  more than the length.
- the answer took **79s** (3 steps, 4 tool calls) — a reply token expires at ~60s, so it went out
  as a push. Model latency, not the bot: worth watching before more people use it.

## P4 — only if P1–P3 are used

- [ ] daily digest as a chat message (one message, plain language) instead of only an alert card
- [ ] remembered preference once set by postback
- [ ] decision: is it worth one message a day out of 300?

## Open questions (from the plan)

- [ ] memory depth: 8 turns — confirm or change
- [ ] acknowledge-from-chat: in or out
- [ ] language: Thai-only or mirror the question's language
