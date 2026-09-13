# LibreChat tool-testing setup — MCP tools + free OpenRouter model (2026-09-14)

## Goal

Make `chat.laundrytwin.duckdns.org` usable for testing ALL LaundroTwin
analytics MCP tools through the Agents feature, using a free OpenRouter model.

## Verified setup

**MCP server (already existed, verified working):**
- `librechat.yaml` → `mcpServers.laundrytwin-analytics` (streamable-http →
  `10.10.0.117:8787/mcp`, Bearer `${MCP_ACCESS_TOKEN}`).
- Token matches between `/opt/librechat/.env` and `/opt/laundrytwin/.env`
  (64 chars).
- Probe (initialize + tools/list): 5 tools —
  `get_revenue_daily`, `get_cycles_daily`, `get_utilization_heatmap`,
  `get_temperature_curve`, `get_weather_usage_correlation`.

**Free model (NEW):**
- `inclusionai/ling-3.0-flash-fin:free` verified on OpenRouter: exists,
  supports tool-calling, context 262144. Direct API test made a correct
  `get_cycles_daily` tool call.
- `librechat.yaml` now has `endpoints.custom` OpenRouter entry with
  `models.default: [inclusionai/ling-3.0-flash-fin:free]` + `fetch: true`.
  `/api/models` shows OpenRouter: 445 models including the model.

**Agents (NEW):**
- `endpoints.agents` block: recursionLimit 25, maxRecursionLimit 50,
  capabilities (tools, chain, context, file_search, web_search,
  execute_code, artifacts), checkpointer (mongo, ttl 86400).
- Agent "LaundroTwin Analytics Tester" created (provider `OpenRouter`,
  model `inclusionai/ling-3.0-flash-fin:free`, all 5 MCP tools attached).
  mcpServerNames: `laundrytwin-analytics`.

**E2E proof (real run):**
- Chat: "How many cycles did branch b1 have on 2026-08-01? Use the
  get_cycles_daily tool..."
- Message parts: `tool_call` name
  `get_cycles_daily_mcp_laundrytwin-analytics` with args
  `{"branchId":"b1","from":"2026-08-01","to":"2026-08-02","accessScope":...}`,
  then reasoning, then final text: "branch b1 had 0 cycles on 2026-08-01"
  (correct: data:[] for that day). unfinished=false, error=false.

## Pitfalls fixed (cost the debug round)

1. **Custom endpoint name must be the provider string.** Agent
   `provider: "openRouter"` (lowercase) failed at chat time with
   `endpoint_models_not_loaded: openRouter` — the models cache is keyed by the
   custom endpoint name as written in yaml. With `name: "OpenRouter"` the
   agent must use `provider: "OpenRouter"` (exact case). 401 on `/api/agents/v1/*`
   is expected — that path is the OpenAI-compatible proxy (API-key auth);
   the JWT-authenticated agent CRUD lives at `/api/agents/` (root).
2. **`requiresOAuth: false` is mandatory for header-auth MCP servers.**
   LibreChat auto-detects a 401 from the MCP server as OAuth-protected
   ("OAuth Required: true") and the server never connects; set it explicitly
   for static-Bearer servers (docs-recommended).
3. **`toolApproval.enabled: true` interrupts EVERY MCP tool call for
   human approval** — the agent paused at `__interrupt__` waiting on a UI
   approval that never comes when driving via API. MCP read-only analytics
   tools don't need it: set `toolApproval.enabled: false`. (Verify via
   `agent_checkpoint_writes` channel `__interrupt__` in Mongo.)
4. **Agents chat payload uses `text` + `messageId`, NOT a `messages[]` array.**
   POST `/api/agents/chat/<endpoint>` with `{messageId, parentMessageId, text,
   agent_id, ...}`; a `messages` array is silently ignored and the agent sees
   a stale/empty user message.
5. **Tool names for agents are `{toolName}_mcp_{serverName}`** — e.g.
   `get_cycles_daily_mcp_laundrytwin-analytics` (from
   `Constants.MCP_DELIMITER = "_mcp_"`). `/api/mcp/tools` returns the exact
   pluginKeys; `/api/agents/tools` lists only non-MCP plugins.
6. `/api/agents/tools` and other agent routes reject requests without a
   browser `User-Agent` header (`uaParser` middleware → "Illegal request") —
   set one when scripting.
7. Node scripts run inside the LibreChat container: `docker exec -i -w /tmp
   LibreChat node script.mjs` (the image has node + fetch; no python3).

## Rollback

- `librechat.yaml.bak-20260914` on VM restores the pre-change config (MCP
  server only, no agents/custom endpoints).
- To drop the free model: remove the `endpoints.custom` OpenRouter block.
- Agent + its Mongo checkpoints are deletable; agent id of the working one:
  `agent_epMxxorPXyIq1jVYf2rCU` (doc `6aa6e9a0175a2638c66f1011`).

## What's left

- UI-side check of the agent in the builder (agent was created via API and
  proven end-to-end via the chat API; visual confirmation + attachment of the
  agent to a conversation from the UI is manual).
- The 5 tools only cover the analytics MCP server; adding more MCP servers
  later follows the same yaml pattern.