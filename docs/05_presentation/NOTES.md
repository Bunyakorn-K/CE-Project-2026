# Presentation build notes (context snapshot)

## Task
User asked (Thai): build slides to present to the professor, giving a rough
picture of the system — with focus on the "Data Structure for LLM" /
Advanced Analytics topic discussed just before.

## Deliverable being built
`docs/05_presentation/llm-analytics-slides.html` — a single self-contained
HTML file (no build step, no deps, open in browser). Reveal-style deck done
with plain CSS scroll-snap sections + arrow-key/space navigation, Thai text,
printable to PDF via browser print.

## Project facts (already gathered — do not re-探索)
- Repo: `/Users/uunw/programming/final-project`, pnpm monorepo, branch `main`.
- Product: **LaundroTwin** (a.k.a. LaundryGo) — Smart Laundry Management and
  Analytics Platform. IoT washing machines -> telemetry -> dashboard + LINE
  alerts + AI Executive Assistant.
- Apps: `apps/api` (Hono-ish TS API, drizzle + SQLite `apps/api/data/demo.sqlite`),
  `apps/web` (Vite + React 19 + HeroUI + Tailwind 4 + LIFF + better-auth).
- API source files: `schema.ts`, `access-policy.ts`, `access-store.ts`,
  `reporting.ts`, `iris-read-client.ts`, `demo-read-client.ts`, `liff-auth.ts`,
  `line.ts`, `index.ts`, `config.ts`, `db.ts`, `auth.ts` (+ `*.test.ts` for most —
  repo has a TDD culture).
- `reporting.ts` exports: `DashboardProjection`,
  `redactDashboardRevenue(dashboard, mayViewRevenue)`,
  `buildThaiStakeholderSummary(input)`, plus private `formatBaht(satang)`
  -> money is stored in **satang** (integer).
- Web source: `App.tsx`, `dashboard-metrics.ts`, `liff.ts`, `auth-client.ts`.
- Docs tree: `docs/01_requirements/` (system_requirement.md, system_functions.md,
  user_stories.md), `docs/02_architecture/` (data-and-activity-diagrams.md,
  laundrotwin-mvp-diagrams.drawio), `docs/03_data_contracts/`
  (data_contracts.md, modbus_frame_analysis.md), `docs/04_traceability/RTM_matrix.md`,
  `docs/integration/iris-laundrytwin-read-api.md`,
  `docs/superpowers/{plans,specs}/` (dated 2026-07-*).
- README status table says: "Safe AI Executive Assistant | Not implemented".

## Requirements that the deck must trace to
- **R08** (MVP) AI Assistance — Executive Summary with safe function calling.
  LLM may only call allowed analytics services; backend verifies roles and
  branch scope; LLM must not execute arbitrary SQL. Deps: aggregated analytics
  APIs, RBAC context, audit log. Example: Owner can request MoM comparison,
  Manager cannot read other branches. Weather is Phase 2.
- **R09** (Phase 2) Promotion recommendations from off-peak historical usage.
- **F-07** (MVP) Authentication and append-only audit log, including AI tool
  calls (actor, action, target, timestamp, outcome).
- **F-11** (MVP) Safe Analytics Function Calling — parse intent to allow-listed
  functions; backend strictly verifies arguments, RBAC, branch scope; logs
  prompt, tool name, sanitized arguments, result reference; arbitrary SQL
  strictly prohibited.
- **F-12** (Phase 2) External context (Weather API), correlation not causation.
- **US-05** (MVP, Owner) scoped Executive Summary. **US-06** (Phase 2, Marketer)
  off-peak promotion windows.
- Data contract: `branch_id` required in every telemetry event and every query,
  server-side scope enforced; `coinbox_open` must come from an explicit mapped
  event, NEVER inferred from `door_status`.
- Architecture: `docs/02_architecture/data-and-activity-diagrams.md` contains
  "Activity Diagram 4: Safe AI Executive Assistant Function Calling" with flow:
  auth check -> store sanitized request -> classify intent / propose allow-listed
  tool -> allow-list check -> build structured args -> strict schema validation
  -> tenant/branch scope check -> analytics service executes parameterized
  function -> log tool name, sanitized args, scope, result ref -> sufficient
  traceable data? -> compose answer from tool output only -> audit -> answer
  states period, metric, caveats.
- ER: `MACHINE ||--o{ MACHINE_CYCLE`, `BRANCH ||--o{ MACHINE_CYCLE`,
  `MACHINE_CYCLE { string cycle_id PK ... }`.

## Answer already given to the user (deck must mirror it)
Nine work items for "Data Structure for LLM":
1. Metric catalog / semantic layer (revenue, cycles, utilization, avg cycle
   time, peak hour) with units (satang), timezone Asia/Bangkok, period grain.
2. Pre-aggregated rollups (hourly/daily per branch per machine) for
   deterministic, fast queries.
3. Tool schemas (zod / JSON Schema): `get_revenue_summary`, `get_utilization`,
   `get_cycle_stats`, `get_peak_hours`, `compare_period` (MoM).
4. Strict argument validation + RBAC branch-scope intersection.
5. Uniform result envelope: `{scope, period, metric, unit, rows, row_count,
   coverage, source, generated_at, caveats}`; LLM cites only these numbers.
6. Token budget: top-N rows plus an "other" bucket, rounding, compact tables.
7. Data-quality flags (telemetry gaps, estimated coin box) surfaced as caveats.
8. System prompt: answer only from tool output; if data insufficient, say so.
9. Audit log of prompt / tool / sanitized args / result ref / outcome, plus a
   golden-question eval set to catch hallucination.

## Status update — 2026-09-06 (deck reflects this now)

- **F-11 / R08 / US-05 are IMPLEMENTED and verified**, not just designed:
  - LINE bot + conversation loop: `apps/api/src/bot/*` (`bot.test.ts` green).
  - Allow-listed MCP analytics server: `apps/api/src/analytics/mcp.ts`
    (`mcp.test.ts` green — bearer auth, tool allow-list, no arbitrary SQL).
  - RBAC branch-scope enforcement: `analytics/scope.ts` + `access-policy.ts`
    (403 out-of-grant tests).
  - Deployed on VM 117; `pnpm test` = 109 tests green, `check` + `build` clean.
- Title slide status changed from "ยังไม่ implement (ตาม README)" to
  "implement แล้ว · MCP allow-list + RBAC scope + audit (ยืนยัน 2026-09-06)".
- PPTX rebuilt from `build_pptx.py` (11 slides) with the updated status.
- Related new capability (same MVP): alert engine `apps/api/src/alert-engine.ts`
  (idempotent LINE push + cooldown + audit, 14 tests) — see
  `docs/04_traceability/ops-verification-2026-09-06.md`.
