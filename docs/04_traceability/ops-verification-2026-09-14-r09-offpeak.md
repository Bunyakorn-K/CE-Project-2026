# R09 off-peak windows — MCP tool `get_off_peak_windows` (2026-09-14)

## What shipped

Sixth allow-listed analytics MCP tool. Answers "when is this branch
off-peak?" with a percentile baseline (per `docs/06_ml/algorithm-comparison.md`
§Baseline): bucket usage by (hour-of-day, weekday), exclude buckets under a
`minCycles` noise guard, sort by lowest paid-cycle usage, return the bottom
`percentile`% with rank 1 = most off-peak. Descriptive only — never a
forecast (R09).

## Design decisions

- **Asia/Bangkok local hours** (user decision 2026-09-14): warehouse stores
  `started_at` as UTC; Thailand is fixed UTC+7 with no DST, so the SQL shifts
  by +7 and computes BOTH hour and weekday from the shifted timestamp — the
  day boundary is Thai midnight, not UTC (`toHour(addHours(started_at, 7))`,
  `toDayOfWeek(addHours(started_at, 7))`). The output carries a caveat.
- Metric = paid cycles (`countIf(status IN ('finished','paid'))`, consistent
  with `DAILY_SQL`); tie-break by total duration minutes. Revenue is not
  required, so the tool is not revenue-gated (`scopeErrorResult(..., false)`).
- Parameters: `minCycles` (default 10), `percentile` (default 25, 1–99) —
  both optional; invalid percentile rejected at the zod schema layer.
- Ranking is a pure TS function (`rankOffPeakBuckets` in
  `apps/api/src/analytics/offpeak.ts`) — filter → sort cycles ASC →
  `max(1, ceil(eligible × percentile/100))` capped at eligible countom its
  own parseable envelope (`meta.rules`).
- `AnalyticsMeta` extended with optional `method`/`rules`/`caveats`
  (backward compatible; the other five tools untouched).
- No REST route added (YAGNI — the MCP surface is what the assistant,
  AI console and LibreChat consume; add an HTTP route only on request).

## Files

- `apps/api/src/analytics/queries.ts` — `OFFPEAK_SQL`, `OffPeakRow`,
  `OffPeakResultRow`, `queryOffPeakWindows` (bind params only, no string
  interpolation — F-11).
- `apps/api/src/analytics/offpeak.ts` (new) — `rankOffPeakBuckets`,
  `WEEKDAY_LABELS` (Mon..Sun, `dayOfWeek - 1` index).
- `apps/api/src/analytics/offpeak.test.ts` (new) — 5 unit cases.
- `apps/api/src/analytics/envelope.ts` — optional meta fields.
- `apps/api/src/analytics/mcp.ts` — `get_off_peak_windows` registration.
- `apps/api/src/analytics/mcp.test.ts` — tools/list now six; 3 new cases.

## Verification (real output)

- `pnpm test` = 132 green (95 api incl. 20 new : 5 offpeak + 15 mcp),
  `pnpm check` + `pnpm build` clean.
- Image pushed to `registry.laundrytwin.duckdns.org/laundrytwin-api:latest`,
  deployed on VM 117 (`laundrytwin-api-1` healthy).
- Live MCP probe `tools/list` → **6 tools** including `get_off_peak_windows`.
- Live tool call, Chiang Mai branch (`5e9611c1-...`), range 2026-08-01 →
  09-14, `minCycles: 5`, `percentile: 25`:
  ```
  meta: { range: {from: "2026-08-01", to: "2026-09-14"},
          branchId: "5e9611c1...", dataSource: "real",
          method: "offpeak_percentile",
          rules: { minCycles: 5, percentile: 25,
                   eligibleBuckets: 134, returnedBuckets: 34 },
          caveats: ["buckets are Asia/Bangkok local hours (UTC+7, no DST)"] }
  rank=1 Mon 03:00 cycles=5 dur=151min
  rank=2 Thu 05:00 cycles=5 dur=158min
  rank=3 Thu 01:00 cycles=5 dur=161min
  rank=4 Wed 01:00 cycles=5 dur=172min
  rank=5 Sun 01:00 cycles=5 dur=178min
  ...
  ```
  Result is business-sensible: all top ranks are 00:00–08:00 local — machine
  types/score 134 eligible buckets (169 possible minus under-minCycles),
  34 returned = bottom 25%.

## What's left / notes

- Data volume is still small (~5.4k rows, one heavy branch) — the research
  doc's Phase B (evaluation harness) and later model candidates stay on the
  roadmap; this is the baseline.
- Bucket counts are honest: a low `eligibleBuckets` (e.g. under default
  `minCycles: 10` on light branches) is the noise guard working, not a bug —
  the rules meta exposes the numbers.
- TMD/weather chaining into recommendations is explicitly out of scope (R12
  is correlation-only).