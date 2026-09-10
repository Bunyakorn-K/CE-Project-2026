# LaundroTwin Backoffice Consolidation — UI & Core Structure Design

Date: 2026-09-10 · Status: **Draft for review** · Scope: design only (no code yet)

Consolidates `apps/web` (LIFF reporting) + `apps/playground` (demo) into ONE
desktop-first backoffice dashboard with an AI admin console, on a modern
stack (TanStack Router + Query, HeroUI, Zod, Jotai, Remeda, CASL). Desktop
is the primary target; the LIFF surface stays usable via responsive collapse.

## 1. Stack decisions (researched via Context7, 2026-09-10)

| Concern | Choice | Notes |
|---|---|---|
| Routing | **TanStack Router (file-based)** | `createFileRoute`, generated `routeTree.gen.ts`, `beforeLoad` auth guard w/ `redirect`, `validateSearch` via `zodValidator` |
| Server state | **TanStack Query v5** | array query keys, `invalidateQueries`, `QueryClientProvider` at root |
| Client state | **Jotai** | `atomWithStorage` for persisted prefs (theme, selected branch); atoms for auth-derived UI state only |
| UI kit | **HeroUI** (already a dep) | Sidebar layout, tables, forms, dialogs |
| Validation | **Zod** | Route search params + forms; schema shared with API where practical |
| Utilities | **Remeda** | data-last functional utils |
| RBAC | **CASL** (`@casl/ability`) | `defineAbilityFor(grants)` — no scattered `canAccessBranch` checks |

**State boundary rule:** server data → TanStack Query only. Jotai holds
client-only state (theme, expanded sidebar, selected branch id that is NOT a
route param — most selection lives in URL search params instead). No
duplication of fetched data in atoms.

## 2. App structure (TanStack Router file-based)

```text
apps/web/src/
  routes/
    __root.tsx                     # Provider mounts: QueryClient, RouterProvider, HeroUI
    index.tsx                      # Landing: LIFF launch or "open dashboard" (redirect /_auth)
    login.tsx                      # Better Auth email/password (non-LIFF, desktop)
    _authenticated.tsx             # Layout: AppShell (sidebar + header); beforeLoad: must be authed
      index.tsx                    # Dashboard (existing KPI + live machines)
      machines.tsx                 # Live machine states (branch-scoped)
      analytics.tsx                # Charts: revenue/cycles/utilization/temperature/weather
      admin.tsx                    # Layout group: ROLE owner only (beforeLoad: ability check)
        index.tsx                  # Admin home — access approvals (existing /mange flow)
        ai.tsx                     # AI settings: model default, system prompt, tools, history
        providers.tsx              # (optional) Bifrost gateway status/view-only
  lib/
    api/            # fetchers + TanStack Query hooks (key factories)
    abilities/      # CASL: ability type, defineAbilityFor(grants), useAbility
    atoms/          # Jotai: themeAtom, sidebarAtom, (authSessionAtom from server)
    components/     # AppShell, Sidebar, DataTable, PageHeader, charts
    schemas/        # zod schemas for search params + forms
  routeTree.gen.ts  # generated
```

**Auth guard** (`_authenticated/beforeLoad`): check Better Auth session via
context; `throw redirect({ to: '/login', search: { redirect: location.href } })`
(confirmed TanStack pattern). `admin` group additionally checks
`ability.can('manage', 'BackofficeAdmin')` → redirect to `/` if false.

## 3. Route map + permissions (CASL)

| Route | Who | Notes |
|---|---|---|
| `/` | all | landing / LIFF entry |
| `/login` | all | desktop email/password |
| `/dashboard` | all authed | KPI reporter |
| `/machines` | all authed (branch scope) | live machines table |
| `/analytics` | all authed (revenue gated: owner+manager) | charts |
| `/admin` | **owner only** | access approvals |
| `/admin/ai` | **owner only** | AI console |
| `/admin/bifrost` | **owner only** | gateway view-only |

CASL ability from grants:

```ts
type AppAbility = MongoAbility<
  [
    'read' | 'manage' | 'update' | 'create' | 'delete',
    'Analytics' | 'Machines' | 'Revenue' | 'BackofficeAdmin' | 'AiAdmin' | `Branch:${string}`
  ]
>;
// owner  → manage BackofficeAdmin, manage AiAdmin, manage all
// manager → read Analytics/Revenue scoped to granted branches
// tech    → read Machines scoped to granted branches
```

UI: a `useAbility()` hook derives from the `/api/auth/me` grants; every
"Go to backoffice" button and admin nav item is `IfCan`-guarded.

## 4. AI console design (`/admin/ai`)

**Philosophy:** Bifrost is the LLM gateway (already deployed at
`https://llm.kovaspire.com`, OpenAI-compatible `/v1`, admin-managed upstreams).
LaundroTwin does NOT store provider credentials — it stores *selection* and
*prompt/tool policy*; sensitive config stays in Bifrost.

| Section | What lives where |
|---|---|
| Default model | LaundroTwin DB (`ai_settings` table): `{ model: string }` — value from Bifrost `/v1/models`; picker lists models (auto-discovered) |
| Model discovery | API proxy: `GET /api/ai/models` → Bifrost `GET /v1/models`, 10-min cache (TanStack Query `staleTime`) |
| System prompt | LaundroTwin DB: template w/ variables `{{role}}`, `{{branches}}`, `{{tools}}`, `{{dataSourceCaveat}}` |
| Tools/MCP inject | auto: server reads allow-listed MCP tool list (`listTools()`) and renders into `{{tools}}` — prompt editor shows live preview, changes apply to bot + future chat |
| Chat history | LaundroTwin DB (`chat_message`) — thread id, role, content, model, token usage |
| Test connection | button → `POST /api/ai/test` → minimal completion through Bifrost (non-streaming, 1 msg) |
| Audit log | append-only `ai_config_audit` (who changed prompt/model when) |

Server additions (apps/api):
- `ai-settings.ts` — CRUD + zod validation + audit write (uses existing SQLite + schema.ts pattern)
- `ai-proxy.ts` — Bifrost client (bearer token from `.env` `BIFROST_API_KEY`, never in browser)
- `ai-models.ts` — discovery + cache
- `ai-history.ts` — chat messages CRUD
- Rewire `conversation.ts` to read default model + prompt template from DB, call Bifrost instead of hardcoded OpenRouter URL; keep MCP allow-list as the tool surface.

## 5. Responsive (desktop-first)

- **≥1280px**: full sidebar (icons+labels), multi-column grids, data tables
- **768–1279px**: collapsed icon sidebar, single-column forms
- **<768px**: bottom-nav mobile shell (Dashboard/Machines/Analytics/Admin),
  preserves current LIFF usage; tables → card list via CSS class switch
- Breakpoints via Tailwind classes on HeroUI `Grid`/components; no separate
  mobile route tree — same components, responsive classes only

## 6. Migration plan (web consolidation)

Phase 1 — Structure base:
1. Add deps: `@tanstack/react-router @tanstack/router-cli @tanstack/react-query @casl/ability jotai remeda` (HeroUI + zod already present)
2. Create `routes/` skeleton + `routeTree.gen.ts` + AppShell (sidebar)
3. Port existing dashboard/report into `/dashboard` with TanStack Query
4. CASL ability from grants; `IfCan` guards; owner "Go to backoffice" button

Phase 2 — AI console:
5. Server: `ai_settings`, `ai_config_audit`, `chat_message` tables + API routes
6. Bifrost client + `GET /api/ai/models` discovery + cache
7. UI: `/admin/ai` (model picker, prompt editor with live `{{tools}}` preview, test button, history)
8. Rewire bot `conversation.ts` → Bifrost + DB prompt/model

Phase 3 — Polish:
9. Responsive pass (desktop-first breakpoints + mobile bottom-nav)
10. Playground retirement (remove `apps/playground`, point VITE_LIFF to web)
11. Move deploy from web:8080 to unified app; Caddy config update if needed

## 7. Open items (need decision)

- **Bifrost API key for LaundroTwin**: generate a dedicated key in Bifrost
  admin (scoped) rather than reusing admin creds — confirm Bifrost supports
  service keys (likely via UI).
- **Chat history retention**: keep 30 days (align w/ Bifrost log retention) or unbounded? recommend 30d + purge job.
- **Playground timeline**: retire in Phase 3, or keep until LIFF parity verified on new shell?