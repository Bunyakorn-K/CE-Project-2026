# LaundroTwin MCP Data Server + LINE Bot + Separate Playground

Date: 2026-08-28
Status: Approved design (team review pending)
Requirements touched: F-04 (future consumer), F-08 (KPI Aggregation), F-11 (allow-listed functions for AI), pillar 4 (Executive Assistant that calls allow-listed analytics functions)

## Purpose

Give branch managers and owners a way to ask natural-language questions about
real branch data from chat platforms, and give every team member a playground
surface that is decoupled from the LINE LIFF demo app:

1. **MCP data server** mounted in the Hono API at `/mcp` — exposes allow-listed
   ClickHouse analytics facts as MCP tools over Streamable HTTP. This is the
   reference implementation of the F-11 tool-function pattern.
2. **LINE chat bot** — a platform-adapter bot that answers manager/owner
   questions in Thai from real data. It is an MCP *client*: the LLM's tool
   calls are routed to the MCP server.
3. **Separate playground service** at `playground.laundrytwin.duckdns.org` —
   team-facing dashboard/API explorer, decoupled from the `apps/web` LIFF app.

## Non-goals

- No arbitrary model-generated SQL. The MCP server only ever runs the fixed
  parameterized templates that already exist in `apps/api/src/analytics/`.
- No Telegram adapter in this iteration (interface only; LINE implemented).
- No new data sources, sensors, or payment writes.
- No product changes to the existing `apps/web` LIFF reporting surface; its
  route to `/playground` is removed once the standalone playground is live.
- No authentication-bypass. Every data access still requires a session or a
  service token, and branch scope is enforced at every layer.

## Context (existing)

- `apps/api` — Hono API with Better Auth sessions, SQLite (grants), and an
  analytics module `apps/api/src/analytics/` (ClickHouse HTTP client, fixed
  SQL templates, envelope with `dataSource` synthetic tagging, RBAC via
  `access-policy`).
- `/webhooks/line` already exists in the API and replies with a canned message
  (`apps/api/src/line.ts`). The bot replaces this handler.
- `mcp.laundrytwin.duckdns.org` currently points at the MCP Inspector UI
  container (port 6274). It is re-pointed at the API `/mcp` endpoint.
- Playground currently lives inside `apps/web` behind the LIFF auth wall.

## Architecture

```text
LINE user ──► LINE Messaging API ──► [Hono API] /webhooks/line
                                          │   bot module (async)
                                          │   └─ OpenRouter (LLM + tool calling)
                                          │        │  MCP client (SDK)
                                          ▼        ▼
                                   /api/v1/analytics/*  /mcp  ──► ClickHouse
                                          ▲                │  allow-listed SQL
   ┌──────────────┐                      │                │
   │ apps/playground │ (playground.laundrytwin)           │
   └──────┬───────┘                                       │
          │ Caddy /api proxy ──► same Hono API ───────────┘
   LINE LIFF/browser ──► apps/web (unchanged demo surface)
```

All AI data flows end at ClickHouse through the fixed templates. The browser
never receives ClickHouse credentials or the MCP service token.

## Component 1 — MCP data server (`apps/api/src/analytics/mcp.ts`)

### Mounting

- New dependency: `@modelcontextprotocol/sdk`.
- `StreamableHTTPServerTransport` wired into a Hono route at `GET|POST /mcp`
  (+ `DELETE /mcp` session teardown), same port as the API (8787). This keeps
  MCP on the existing deploy surface and lets the bot reach it via localhost.
- Authentication: every request must carry `Authorization: Bearer
  $MCP_ACCESS_TOKEN`. Missing/invalid token → 401. The endpoint is reached
  externally through Caddy at `mcp.laundrytwin.duckdns.org` (see Deployment).

### Tools (allow-listed)

Each tool maps 1:1 to an existing analytics query. Tool input carries an
explicit `accessScope` so the server enforces declared scope; the bot derives
that scope from the user's grants (see Component 2).

| Tool | Query source | Required inputs | Revenue-gated |
|---|---|---|---|
| `get_revenue_daily` | `DAILY_SQL` (revenue) | `branchId`, `from`, `to` | yes — requires `accessScope.canViewRevenue` |
| `get_cycles_daily` | `DAILY_SQL` (cycles) | `branchId`, `from`, `to` | no |
| `get_utilization_heatmap` | `HEATMAP_SQL` | `branchId`, `from`, `to` | no |
| `get_temperature_curve` | `CURVE_SQL` | `branchId`, `from`, `to`, `machineId?` | no |

No `get_branch_summary` tool: the bot's LLM composes summaries from the facts
returned by the individual tools (revenue + cycles + utilization), which keeps
the MCP server free of the IRIS reporting pipeline and works on synthetic data.

`accessScope` = `{ branchIds: string[], canViewRevenue: boolean }`. A `"*"`
entry in `branchIds` means tenant-wide (owner). Server rejects `branchId ∉
accessScope.branchIds` unless tenant-wide (error `branch_out_of_scope`) and
rejects revenue tools when `canViewRevenue` is false (`revenue_forbidden`).
`branchId=""` on a tenant-wide scope is the unfiltered window, matching the
existing `resolveAnalyticsScope`/SQL sentinel semantics. This preserves the CE
invariant: the MCP server enforces the declared scope against allow-listed
queries; the bot is the trusted component that derives the true scope from user
grants.

### Data layer (no duplication)

Extract the fixed SQL templates + row-shaping from `revenue.ts`,
`utilization.ts`, `temperature.ts` into `apps/api/src/analytics/queries.ts`:

- `queryDailyRevenue(clickhouse, params)` → rows
- `queryDailyCycles(clickhouse, params)` → rows
- `queryUtilizationHeatmap(clickhouse, params)` → rows
- `queryTemperatureCurve(clickhouse, params)` → rows

The existing Hono route handlers are refactored to call these functions (same
SQL text, same bind params — no behavior change). The MCP server calls the same
functions. Envelope + `dataSource` synthetic tagging are reused unchanged, so
MCP tool responses keep `{ meta: { range, branchId, dataSource }, data }`.

### Errors

| Case | Behavior |
|---|---|
| Missing/invalid bearer token | 401 `unauthorized` |
| Unknown tool | tool error `unknown_tool` |
| Branch out of scope | tool error `branch_out_of_scope` |
| Revenue tool without `canViewRevenue` | tool error `revenue_forbidden` |
| Invalid range (reuses `parseAnalyticsRange`) | tool error `invalid_range` |
| ClickHouse unreachable | tool error `analytics_source_unavailable` |

## Component 2 — LINE chat bot (`apps/api/src/bot/`)

### Placement

A module inside the API (`apps/api/src/bot/`), not a separate workspace
package, because it reuses `access-store` (`findLiffUser`,
`resolveUserPrincipal`), `access-policy` (`canAccessBranch`,
`mayViewRevenue`), the ClickHouse client, and the MCP server — all already in
the API. The module is structured behind a `PlatformAdapter` interface so it
can be extracted to a standalone service later without logic changes.

### Adapter pattern

```ts
interface PlatformAdapter {
  platform: "line" | "telegram";
  extractUserId(event: unknown): string | null;
  sendText(userId: string, text: string): Promise<void>;
}
class LineAdapter implements PlatformAdapter { ... } // v1
class TelegramAdapter implements PlatformAdapter { ... } // stub, not wired
```

`apps/api/src/bot/adapter.ts` defines the interface; `line-adapter.ts`
implements it with `@line/bot-sdk` (`MessagingApiClient.pushMessage`).

### Identity resolution

For a LINE text message event:

1. `findLiffUser(event.source.userId)` — if null, push
   "บัญชี LINE นี้ยังไม่ได้รับสิทธิ์ กรุณาติดต่อผู้ดูแล" and stop.
2. `resolveUserPrincipal(user, "liff")` → `Principal.grants`.
3. If grants empty → push the same no-access message.
4. Derive `accessScope`:
   - `branchIds` = distinct granted branchIds; owner grant (branchId null) → `["*"]`
     (tenant-wide, so `branchId=""` = unfiltered window).
   - `canViewRevenue` = any grant role is `owner` or `manager`.
5. Build the assistant system prompt in Thai: role, accessible branches, and a
   rule that answers only from provided data, never fabricating numbers.

### Conversation loop (async, push-reply)

LINE `replyMessage` must be used within ~60s of the webhook; LLM + tool calls
can exceed that. The bot therefore **acknowledges the webhook immediately** and
**answers via `pushMessage`** to the user's LINE ID.

1. `POST /webhooks/line` → validate signature → for each text event, start async
   processing (no `await` on the LLM path). Return 200 immediately.
2. Async: resolve identity → build messages → call OpenRouter chat completions
   with `tools` = the MCP tool schemas.
3. If the model returns `tool_calls`: route each to the MCP server
   (`POST /mcp` locally, bearer `MCP_ACCESS_TOKEN`), append tool results, call
   OpenRouter again. Single tool round-trip max in v1.
4. Final assistant text → `LineAdapter.sendText(userId, text)`.

Per-user in-flight guard prevents overlapping answers for the same user
(an in-memory `Set<string>` of busy userIds; a queued message is dropped with a
"กำลังหาคำตอบ…" hint instead of spamming).

### OpenRouter integration

- Endpoint `POST https://openrouter.ai/api/v1/chat/completions` (OpenAI-compatible),
  `Authorization: Bearer $OPENROUTER_API_KEY`.
- Model from env `BOT_MODEL` (default a capable tool-calling model available on
  OpenRouter). Timeout ~60s. Non-2xx → push "ขออภัย ติดปัญหาเชื่อมต่อผู้ช่วย".
- Tool schemas: derived from the MCP server's `list_tools` response and passed
  through in OpenAI `tools` format. No duplicated schema definitions.

### Files

```
apps/api/src/bot/
├── adapter.ts        # PlatformAdapter interface + registry
├── line-adapter.ts   # LineAdapter (pushMessage)
├── identity.ts       # resolve lineUserId → principal → accessScope
├── conversation.ts   # message → OpenRouter tool loop → final text
├── mcp-client.ts     # thin MCP client (list_tools / call_tool over fetch)
└── index.ts          # Hono sub-router, /webhooks/line wiring
```

## Component 3 — Separate playground service (`apps/playground`)

### Package

New workspace package `apps/playground` (Vite + React). It reuses the existing
`PlaygroundScreen` experience from `apps/web` (health cards, endpoint explorer,
analytics quick buttons) as a standalone app. The `/playground` route and
`PlaygroundScreen` are removed from `apps/web`.

- Auth: same as the main app — on load `GET /api/me`; if 401, show an access
  screen (LINE login + demo button). No automatic demo fallback (AGENTS.md).
- Data: relative `/api/*` and `/health` calls. Caddy proxies `/api` and
  `/health` on the playground subdomain to the API so cookies are same-origin
  and no CORS change is needed.

### Caddy routing (Pi)

```text
playground.laundrytwin.duckdns.org {
    import hide-server
    handle /api/* { reverse_proxy 10.10.0.117:8787 }
    handle /health { reverse_proxy 10.10.0.117:8787 }
    handle { reverse_proxy 10.10.0.117:8082 }   # playground nginx
}
```

## Deployment

### VM 117 `/opt/laundrytwin`

- `Dockerfile`: add a `playground` build stage (Vite build → nginx, mirroring
  the existing `web` stage) OR a separate `apps/playground/Dockerfile`.
- `compose.yaml`: add `playground` service exposing port 8082.
- `.env` additions:
  ```
  MCP_ACCESS_TOKEN=<long-random-token>
  MCP_ALLOW_REVENUE=true            # service token capability flag
  OPENROUTER_API_KEY=<key>
  BOT_MODEL=<model>
  LINE_CHANNEL_ACCESS_TOKEN=<set>   # already a placeholder in .env.example
  LINE_CHANNEL_SECRET=<set>
  ```
  `MCP_ALLOW_REVENUE=false` revokes revenue tools for the service token
  regardless of `accessScope.canViewRevenue`.

### Pi Caddy (`/home/dietpi/stack/caddy/Caddyfile`)

- Add `playground.laundrytwin.duckdns.org` block (above).
- Change `mcp.laundrytwin.duckdns.org` from `10.10.0.117:6274` (inspector) to
  the API `/mcp`: `reverse_proxy 10.10.0.117:8787`. Remove `authentik-protect`
  from that block — the MCP endpoint is token-authenticated (the bot carries a
  bearer token; a future human browser would use the inspector's own surface).
- The MCP Inspector container stays running for local debugging but is no longer
  the public `mcp.` target.

## Security and invariants

- Money stays satang integers end to end.
- No credentials in the repo; `.env.example` gains the new placeholders only.
- The MCP server runs only allow-listed parameterized templates — no dynamic
  SQL, no string interpolation of user/model input. This is the F-11 reference
  implementation for AI tool functions.
- Branch scope is enforced at the MCP server (declared `accessScope`) and the
  bot derives that scope from server-resolved grants — a LINE user can never
  request a branch they are not granted.
- Synthetic data remains labeled via the existing `meta.dataSource` envelope;
  the bot's system prompt is told to surface "ข้อมูลจำลอง" when `dataSource`
  is `synthetic`/`mixed`.

## Testing

- **queries extraction**: existing analytics tests still pass unchanged
  (refactor is behavior-preserving); contract test keeps OpenAPI routes intact.
- **MCP endpoint** (`mcp.test.ts`): missing/invalid token → 401; `list_tools`
  returns the 4 tools; each `call_tool` routes to the right query (mocked CH);
  branch-out-of-scope rejected; tenant-wide scope accepts `branchId=""`;
  revenue tool without `canViewRevenue` rejected; `dataSource` synthetic
  tagging preserved.
- **Bot** (`bot.test.ts`): unknown LINE user → no-access reply; grants →
  correct `accessScope`; tool-call loop (mock OpenRouter + local MCP);
  revenue scope for technician vs owner/manager; per-user busy guard.
- **Playground**: `pnpm --filter @laundrytwin/playground check` + build.

## Verification

```bash
pnpm --filter @laundrytwin/api test
pnpm check && pnpm build
# manual: restart api, curl -H "Authorization: Bearer $MCP_ACCESS_TOKEN" http://10.10.0.117:8787/mcp
# LINE: message the bot from a granted LINE account, confirm push reply
# playground: open https://playground.laundrytwin.duckdns.org, confirm login + tabs
```

## Build order

1. Extract `analytics/queries.ts` (refactor, tests green).
2. MCP server (`analytics/mcp.ts` + `/mcp` route + tests).
3. Bot module (`apps/api/src/bot/` + tests).
4. Playground package (`apps/playground`), remove `/playground` from `apps/web`.
5. Deploy: compose + Dockerfile stage, Caddy edits, `.env`.

## Unresolved items

- Which OpenRouter model to pin as `BOT_MODEL` — decide at deploy time.
- Whether the bot needs a short-term memory of branch context beyond the
  system prompt (v1 is stateless per message).
- Telegram adapter is interface-only; implementation deferred until LINE flow
  is proven.
