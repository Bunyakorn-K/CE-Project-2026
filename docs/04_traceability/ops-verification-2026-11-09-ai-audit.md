# R08 / F-07 — the AI surface now records what it called, with digests

**Date:** 2026-11-09
**Files:** `apps/api/src/ai-audit.ts`, `apps/api/src/ai-audit.test.ts`,
`apps/api/src/ai-routes.ts`, `apps/api/src/ai-settings.ts`,
`apps/api/src/bot/conversation.ts`, `apps/api/src/bot/index.ts`,
`apps/api/src/llm-client.ts`
**Status: audit rows verified from a real HTTP request to `/api/ai/chat`. A real
*tool* call has not been recorded — see "NOT verified".**

## What changed

| Row | When | Contents |
|---|---|---|
| `action = 'ai.tool_call'` | every tool call, **including one that throws** | `{model, toolCallId, argsDigest, argsKeys, resultRows, durationMs, outcome, errorName?}` |
| `action = 'ai.chat'` | every chat request | `{model, threadId, messageCount, usedTools, outcome}` |

`argsDigest` is a SHA-256 over canonicalised arguments — keys sorted recursively,
so `{a,b}` and `{b,a}` digest the same. **Arguments are never stored**, only
digested, and only their *names* travel alongside. That tradeoff is deliberate:
tool arguments carry branch ids, date ranges and revenue scopes, and an audit
table must not become a second copy of the data it audits. `argsKeys` keeps the
shape a reviewer actually needs.

The error path records `errorName` only, never the message: a driver error can
quote a connection string, and this table is not allowed to accumulate one.

The tool-call row is written by `runAuditedToolCall`, which both the agentic
bot path and any future caller use, so "one row per call" is structural rather
than remembered.

## Two defects found while making the acceptance possible

Both were latent: the code paths existed but nothing had ever exercised them.

1. **`POST /api/ai/chat/purge` could not run at all.** It bound a `Date` into a
   SQL comparison against an integer millisecond column: better-sqlite3 answers
   `SQLite3 can only bind numbers, strings, bigints, buffers, and null`. It also
   used `require()` inside an ESM module. Now a static import with the cutoff
   bound as `getTime()`.
2. **The development bypass could not write an audited row.** `audit_log.
   actor_user_id` and `chat_message.user_id` are foreign keys into `user(id)`,
   and the bypass principal (`development-owner`) is deliberately not a persisted
   user — `index.test.ts` asserts that reading `/api/me` creates no user row.
   The invariant was kept. Instead `resolveAuditActor` stores `actorUserId: null`
   with `actorUnresolved: true`, and the chat route skips the history write for
   an actor it cannot name (the request is still answered and still audited).
   In production every principal is a real user, so that branch never runs.

## Verified: the real call

```bash
# node v24.21.0, NODE_ENV=development LAUNDRYTWIN_DEV_BYPASS=true
# DATABASE_PATH=<scratch>/ai-audit-dev3.sqlite, PORT=8799
curl -X PUT  http://127.0.0.1:8799/api/ai/settings -d '{"baseUrl":"http://127.0.0.1:8801","apiKey":"…","model":"stub-model"}'
# → 200
curl -X POST http://127.0.0.1:8799/api/ai/chat -d '{"message":"สรุปยอดรอบซักเมื่อวานให้หน่อย"}'
# → {"threadId":"94801229-dba0-48ae-b0c0-9a488eda40a6","reply":"stub reply for the audit record"}
```

The rows that call left in `audit_log`, read back from the same SQLite file:

```json
{"action":"ai_settings.update","target":"ai_settings:default","actor":null,
 "detail":{"baseUrl":"http://127.0.0.1:8801","model":"stub-model","temperature":70,
           "keyChanged":true,"actorUnresolved":true}}
{"action":"ai.chat","target":"94801229-dba0-48ae-b0c0-9a488eda40a6","actor":null,
 "detail":{"model":"stub-model","threadId":"94801229-dba0-48ae-b0c0-9a488eda40a6",
           "messageCount":1,"usedTools":false,"outcome":"ok","actorUnresolved":true}}
```

`user` and `chat_message` row counts after that call were **0** and **0** — the
bypass still persists nothing.

**The upstream gateway was a local OpenAI-compatible stub, not Bifrost.** It
streams the same SSE shape the real gateway does, so the route, the AI SDK
client and the audit write are all the production code; only the model is a
stub. The record says so rather than implying a live model answered.

14 tests cover the rest, and the important ones are about what a row may not
contain: a branch id passed as an argument never appears in `detail`; an
environment value passed as an argument never appears in `detail`; a thrown
tool writes exactly one row with `outcome: "error"`, `resultRows: null`, and the
error's *name* but not its message; `purge` deletes the conversation and leaves
the audit row in place.

## NOT verified

- **No `ai.tool_call` row from a real request.** Producing one needs a LINE
  webhook with a valid signature, a LINE-linked identity, an MCP session and a
  model that emits a tool call. The write path is the same function the tests
  drive, and the agentic executor is wired to it, but "wired" is not "observed".
- **Nothing in production.** No AI call has been made against
  `laundrytwin:deploy-4fb470d-20261109` with this code, and that image does not
  contain it.
- The digest's stability across SDK versions is unverified; it is a SHA-256 over
  `JSON.stringify` of a canonicalised object, which is stable for the value
  shapes these tools take (strings, numbers, arrays) and would not be for a
  `Date` or a `Map`.
