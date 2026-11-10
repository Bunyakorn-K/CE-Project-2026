# AI chat — task list

Companion to [`2026-11-10-ai-chat.md`](./2026-11-10-ai-chat.md). One line per
deliverable, ticked when it is built **and** verified. The plan holds the reasoning;
this file holds the state.

Legend: `[ ]` not started · `[x]` built and verified

## P1 — a conversation instead of a question

- [ ] `chat_turn` table (schema, DDL, index on `(line_user_id, created_at)`)
- [ ] `bot/memory.ts`: `appendTurn`, `recentTurns(limit=8)`, `purgeExpiredChatTurns` (30 days, same window as `chat_message`)
- [ ] `llm-client.agenticAnswer` accepts prior `messages`, not only `input`
- [ ] `conversation.ts` feeds the last 8 turns and asks for the current question only
- [ ] `showLoadingAnimation` on receipt — adapter method, LINE implementation, called before MCP/LLM work
- [ ] one-slot queue per LINE user replaces the `busy` Set (a second message waits, it is not dropped)
- [ ] `max_steps` in `ai_settings` (default 4), used by the bot, editable in `/admin/ai`
- [ ] tests: memory, history plumbing, queue order, loading called, settings range
- [ ] deployed and observed: follow-up question answered in context; two quick messages both answered; typing indicator seen

## P2 — the bot can be talked to, not just asked

- [ ] postback handler with typed payloads (`ack:<alertId>`, `branch:<id>`, `help`)
- [ ] `รับทราบ` via postback writes `alert_acknowledgement`, re-checks scope server-side, replies with what changed
- [ ] quick replies on the first message of a thread (ภาพรวมวันนี้ / เครื่องที่มีปัญหา / แจ้งซ่อม)
- [ ] follow event → welcome message (carries a reply token, so free) naming what the bot can answer
- [ ] `help` answer with three role-appropriate example questions, from the same definitions the rich menu uses
- [ ] tests: postback scope rejection, ack idempotence, quick-reply payloads, follow handling

## P3 — it cannot surprise us

- [ ] answer shaping: ≤ 900 characters, ≤ 2 messages, split on paragraph boundaries, never mid-word
- [ ] `chat_turn` records model / steps / tool_calls / latency_ms / chars / delivered / tokens and `/admin` shows today's totals
- [ ] rate limit: 20 messages/hour/user, 300/day across users, refused in Thai with the reason
- [ ] chat pushes counted against the same monthly LINE budget as alerts, shown beside it in `/admin/alerts`
- [ ] `CHAT_ENABLED` switch (env or setting) that turns chat off without a deploy
- [ ] tests: shaping at the boundaries, limiter arithmetic, budget counting, switch off

## P4 — only if P1–P3 are used

- [ ] daily digest as a chat message (one message, plain language) instead of only an alert card
- [ ] remembered preference once set by postback
- [ ] decision: is it worth one message a day out of 300?

## Open questions (from the plan)

- [ ] memory depth: 8 turns — confirm or change
- [ ] acknowledge-from-chat: in or out
- [ ] language: Thai-only or mirror the question's language
