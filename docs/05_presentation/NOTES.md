# Presentation build notes (current evidence)

## Deliverable

`docs/05_presentation/llm-analytics-slides.html` is the self-contained HTML
source for the professor presentation. It uses Thai-first copy, native HTML/CSS
slides, keyboard/scroll navigation, and browser print-to-PDF. The PowerPoint
source is `docs/05_presentation/build_pptx.py`; do not run the generator unless
explicitly requested.

## Current implementation facts (2026-09-25)

- Product: **LaundryTwin**, a Smart Laundry Management and Analytics Platform.
- The active web router includes branch/date filters, nullable revenue,
  source/freshness/availability states, analytics series and tables, alert
  evidence and acknowledgement, owner-only admin access/grants, AI settings and
  history, owner-only Playground, legal navigation, and LIFF error retry.
- Screenshot/browser QA is still pending. LINE/browser E2E is not verified.
- Local automated evidence is 181 tests: API 142, web 2, ETL 37. The API check,
  web check/test/build, and ETL test pass under Node.js 24.13.0.
- Better Auth requires `BETTER_AUTH_SECRET` outside tests, disables public
  signup, and enables rate limits. Development bypass requires both
  `NODE_ENV=development` and `LAUNDRYTWIN_DEV_BYPASS=true`, creates an in-memory
  owner, and is not a production design.
- Demo mode is explicit, requires a demo session cookie, and is preview-only.
- MCP requires `MCP_ACCESS_TOKEN`; `MCP_ALLOW_REVENUE` is explicit false by
  default. The LINE bot derives per-session scope from server-resolved grants
  and signs it; `accessScope` is not a model argument.
- Direct ClickHouse Dashboard/Twin routes have local code/test evidence for
  branch scope, zero-grant denial, strict calendar dates, bind parameters,
  nullable revenue redaction, active inventory retention, usage-derived
  freshness, and unknown-state preservation. This is not production E2E.
- Current analytics envelope is `{ meta, data }`. `meta` contains range,
  branchId, dataSource, and optional method/rules/caveats.
- Current local audit entries cover grants, alerts, and settings. There is no
  complete append-only AI prompt/tool-call/result audit table.

## Current six MCP tools

The deck must use these exact current names:

1. `get_revenue_daily`
2. `get_cycles_daily`
3. `get_utilization_heatmap`
4. `get_temperature_curve`
5. `get_weather_usage_correlation`
6. `get_off_peak_windows`

`get_off_peak_windows` is a Phase 2 percentile baseline, not a forecast. The
F-12 label is formally Weather Context in `system_functions.md`; historical
documents used it ambiguously for off-peak work, so the deck must not invent a
new F-ID.

## Target architecture, not current implementation

The presentation may explain the following as a target design when labeled:

- A pre-aggregated `metric_rollup_hourly` table and rollup maintenance layer.
- Conceptual tool names such as `get_revenue_summary`, `compare_period`,
  `get_cycle_stats`, and `get_peak_hours`; these are not the current six MCP
  names.
- A richer envelope with `scope`, `period`, `metric`, `unit`, `rows`,
  `row_count`, `coverage`, `source`, `generated_at`, `caveats`, and
  `result_ref`.
- A complete append-only AI prompt/tool-call/result audit trail and
  golden-question evaluation set.

Do not present target rollups, conceptual tool names, richer envelope fields, or
full AI audit as already shipped. Current code is useful to show first, with
the target extension clearly marked.

## Professor-facing story

Keep the explanation Thai-first and practical: human question → server-derived
scope → allow-listed tool → parameterized ClickHouse query → explicit source,
range, freshness, and caveat → Thai answer. Explain that the current six tools
and `{ meta, data }` envelope are the verified baseline; the richer semantic
layer is a next-step architecture. The external IRIS contract remains
`/v1/laundrygo` with `X-LaundryGo-Read-Key` when the integration is mentioned.
