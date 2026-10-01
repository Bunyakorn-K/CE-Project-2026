---
score: 25
max_score: 40
method: dual-agent
agent_a: acd77d76387d87b6d
agent_b: a9a19a14cf559950f
date: 2026-10-01
target: src/routes/_authenticated/dashboard.tsx
target_identity: "file:apps/web/src/routes/_authenticated/dashboard.tsx"
target_fingerprint: "sha256:2b99c0ab0d9bc42d94ddd1938bc82b5b86f1b3770dbe0de1220fd65bf03f2392"
target_path: apps/web/src/routes/_authenticated/dashboard.tsx
timestamp: 2026-10-01T04-56-11Z
slug: src-routes-authenticated-dashboard-tsx
---
Method: dual-agent (A: acd77d76387d87b6d · B: a9a19a14cf559950f)

Target: `apps/web/src/routes/_authenticated/dashboard.tsx` · Mode: Operate
Product truth: `apps/web/PRODUCT.md` · Design truth: `apps/web/DESIGN.md`

---

## 1. Design Health Score

| # | Heuristic | Score | Justification |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Source, availability, range, `fetchedAt` and usage-row count are on screen (`dashboard.tsx:246-251`, `:298-304`), but the Digital Twin never says how old a machine's state is. |
| 2 | Match with the real world | 2 | Plain Thai operational language and satang-only arithmetic are right, but `dashboard.tsx:510` tells a user their machine has "ไม่มีแถว usage" — a provenance claim the API never made. |
| 3 | User control and freedom | 2 | Filters, retry and tabs exist, but no route has `validateSearch` and there is no reset; a LINE back gesture or refresh discards the whole working context silently. |
| 4 | Consistency and standards | 2 | Status vocabulary is genuinely shared (`machine-status.ts:8-35`), but the freshness vocabulary `machines.tsx:155,167` uses is absent here, and four divergent `sourceLabel` implementations now exist. |
| 5 | Error prevention | 3 | Cross-bounded dates (`:268-281`), `validRange` gating every query (`:168`, `:178`, `:184`, `:192`) — `from > to` cannot produce a request. |
| 6 | Recognition over recall | 3 | Every figure carries its basis where it matters (`dashboard-view.ts:99`, `:170`); nothing depends on memory or hover. |
| 7 | Flexibility and efficiency | 2 | No date presets, no prior-period comparison, no sort, no shareable URL. The two questions an owner opens this page with have no path. |
| 8 | Aesthetic and minimalist | 2 | The same four provenance facts print three times per load (`:246-251`, `:298-304`, `:326-333`); each machine card spends a 96px SVG on two bits of state. |
| 9 | Recognize / diagnose / recover | 2 | Error banners render the server's **English** prose verbatim inside Thai copy (`api/client.ts:12-19` → `:288`, `:292`, `:315`, `:375`), and the branches failure at `:288` has no retry while `:291` does. |
| 10 | Help and documentation | 3 | Section descriptions carry real methodology (`:346`, `:462`), but the utilization bar has no legend and `.legend` (`styles.css:892-901`) has no JSX consumer. |

**Total: 25 / 40.** No heuristic `n/a`; no renormalization.

---

## 2. Design Specificity Verdict

**Specific to LaundryTwin operations — with one clearly generic half.**

Real domain evidence, not template-ability:
- `dashboard-view.ts:70-118` encodes a **three-state** revenue split (redacted-by-grant / absent-because-empty / real number) keyed on `revenueSatang === null`. A generic dashboard has a number or a dash. This is forced by `apps/api/src/reporting.ts:12-36`, which nulls revenue per branch *and* in totals.
- `dashboard.tsx:305` surfaces a raw `usageRowsInRange` as provenance. No off-the-shelf dashboard prints its own denominator next to the KPI.
- `dashboard.tsx:310-312` renders `cycleAttributionView`, stating in Thai that 280 of 412 counted rows carry no `machine_session_id` — because the canonical cycle definition is `countIf(status IN ('paid','finished'))` over *rows*, not identified sessions (`apps/api/src/report/clickhouse-report.ts:108-130`).
- `machine-status.ts:12-16` keeps `paid` and `finished` as separate Thai labels, with a comment saying upstream still owes an explanation. A template cannot produce that pedantry.

**The caveat:** the Digital Twin tab is the generic half. `MachineDrum` (`dashboard.tsx:518-534`) is a washing-machine illustration whose CSS (`styles.css:805-810`, `:837-840`) draws only four meaningful variants across nine enum values, and the LED at `styles.css:833-835` is unconditionally green regardless of status. The twin is a laundromat-shaped template layered over laundromat data; the KPI panel is real domain work.

---

## 3. Overall Impression

This is a carefully built surface with a real spine. The presentation-state mapping in `src/lib/` is the strongest code in the app, and it does the hard thing — naming *why* a number is a number rather than just rendering it. Hiding the executive summary only for a genuinely empty window (`summary-view.ts:27-43`), keeping `NO_USAGE_VALUE` distinct from `0`, refusing to draw a 0% utilization bar when the numerator is unknown, and preserving the active-inventory LEFT JOIN so a quiet branch doesn't empty out — these are decisions most production dashboards get wrong.

The weaknesses concentrate in exactly the wrong place: honesty. The twin asserts a fact about the user's data that the API did not say. The twin has no freshness vocabulary at all, though the vocabulary *and the server-side computation already exist*. And error banners pour the server's English prose into a Thai-first page — the precise defect `PRODUCT.md:77` records as already fixed once.

Structurally this is a well-built console that has not yet absorbed the two questions operations actually asks: *what changed* and *which one is worst*. Everything is an absolute total for a window; nothing can be pointed at, linked to, or compared.

---

## 4. What's Working

- **Three-state revenue modeled end to end.** `dashboard-view.ts:85-90` distinguishes null from zero from real, and `branchStatCells:129-134` applies the same per branch. A technician sees "ไม่พร้อมใช้งาน / ไม่มีสิทธิ์ดูรายได้" rather than a fake ฿0 — and the server already nulled it (`reporting.ts:26-36`), so the browser is not the security boundary.
- **The cycle KPI names its own basis on the card** (`dashboard-view.ts:95-99`): `นับจากแถว usage · ข้อมูล ${range}`, with a comment naming the 2026-09-29 decision. Correct response to a row-based canonical definition.
- **`cycleAttributionView` validates before believing** (`dashboard-view.ts:223-237`): non-finite, negative, or non-adding triples degrade to `unknown` with a Thai reason, never to a percentage — and `unknown` *renders* rather than collapsing into "no data".
- **Date inputs are cross-bounded and the query is gated** (`:268-281`, `:168`) — `from > to` cannot produce a request.
- **Active-inventory retention survives to the UI.** `clickhouse-report.ts:132-159` keeps `active = 1` machines with no usage in the window, so the twin doesn't empty out when a branch was quiet. A subtle failure most implementations get wrong.
- **Unknown enum values show verbatim** rather than hiding (`machine-status.ts:31-35`), citing the data-quality requirement. Flagging beats swallowing.
- **The demo path refuses to fabricate.** `index.ts:588-625` sets `usageRowsInRange: null` and `cycleAttribution: null` rather than 0, so `usagePresence` propagates `unknown` and every KPI reads `ไม่มีข้อมูล` instead of demo zeros posing as real.
- **Detector-clean markup, verified as a true negative.** All five route files scan `[]` even with `--no-config --no-design-system --no-inline-ignores`, and an in-repo probe with off-palette values returned 3 findings — so the empty result is real, not suppressed. Zero hex colors or px literals in `dashboard.tsx`; all 84 `className` refs route through `styles.css`.
- **Zero runtime defects at either breakpoint.** Live Chromium against the production bundle, 390×844 and 1440×900, in *both* a degraded (503) and a populated state: no horizontal overflow, no overflowing or clipped elements, **0 console errors, 0 page errors, 0 failed requests**. Long Thai branch names render clean at both widths.

---

## 5. Priority Issues

### P1 — The Digital Twin states a provenance claim the API never made

**What.** `dashboard.tsx:510` renders `machine.cycleCountSource === "usage_row" ? "นับจากแถว usage" : "ไม่มีแถว usage"` — "no usage row". But `apps/api/src/report/clickhouse-report.ts:387-399` computes `cycleCount = countedCycles > 0 ? countedCycles : null`. A machine *with* usage rows whose rows are all `pending_payment`, `admitted` or `cancelled` has `countedCycles === 0` → `null` / `"unavailable"` → the card asserts it has **no usage rows**. It has rows; none reached a counted state.

**Why it matters.** This is the product's core principle failing in the *opposite* direction — overstating a data gap. A technician investigating a machine the dashboard says has no usage will stop looking, when it is in fact being used. It also poisons trust in every other provenance label on the card, because one is demonstrably wrong.

**Fix.** Make the API distinguish three cases, not two: `cycleCount: 0` with `cycleCountSource: "usage_row"` when rows exist but none count, versus `null` / `"unavailable"` when `usageRows === 0`. Print `0` for the first, keep `ไม่พร้อมใช้งาน` for the second. Do not infer "no rows" in the view — that inference is the defect.

**Suggested command:** `/impeccable clarify`

### P1 — The Digital Twin has no freshness vocabulary, so stale renders as live

**What.** `dashboard.tsx` never imports or renders freshness. The `Machine` type at `:73-83` has no `freshness` field. It refetches every 60s (`:185`) and prints `ดึงเมื่อ {fetchedAt}` (`:250`) — the time the *report was built*, not how old the machine evidence is. Meanwhile `apps/web/src/lib/machine-status.ts:43-74` already defines `FRESHNESS` with Thai labels (stale = เก่ากว่า 30 นาที), `apps/api/src/index.ts:787-793` already computes it for `/api/report/live`, and `machines.tsx:155,167` already consumes it. Only this surface omits it.

**Why it matters.** `clickhouse-report.ts:141-159` derives status from `argMax(u.status, u.started_at)`. A branch whose machines stopped reporting days ago still renders a confident status pill, possibly the running wave (`:519`), and a `ใช้งานล่าสุด` line — with nothing marking the pill as describing the past. For an owner deciding whether to dispatch a technician, "กำลังใช้งาน" and "กำลังใช้งาน as of Tuesday" are different decisions. The vocabulary and the computation already exist.

**Fix.** Add `freshness` to the `/api/twin` payload, to the `Machine` type, and render a second pill in `MachineCard` (`:504-506`) using the shared `freshnessMeta` — identical to `machines.tsx:166-169`. Status and freshness are different axes and must not collapse into one (PRODUCT.md:107).

**Suggested command:** `/impeccable harden`

### P1 — Server-supplied English reasons reach the Thai-first page verbatim

**What.** `dashboard.tsx:110` throws `new Error(await apiErrorMessage(response, fallback))`, and `apps/web/src/lib/api/client.ts:12-19` prefers the server's own `message`/`error` string. Those strings are English (`apps/api/src/analytics/scope.ts:41-59` → `"Analytics range is capped at 90 days"`; `index.ts:973-984` → `"IRIS reporting is not configured for LaundryTwin"`) and render into a Thai sentence at `:288`, `:292`, `:315`, `:375`. A user reads `ไม่สามารถโหลดแดชบอร์ดได้: Analytics range is capped at 90 days`. `dashboard.tsx:154` and `summary-view.ts:62` additionally interpolate a raw `availability` value.

**Why it matters.** `PRODUCT.md:77` names this as a brand commitment and records it as a real defect already fixed. It is back, on the highest-traffic failure path of the main page. Worse, a reworded server string silently produces an untranslated banner with **no test failing** — the exact failure mode `alerts-view.ts:22-36` was written to prevent, with the comment "Matching prose would break silently the first time that string is reworded."

**Fix.** Add a shared `lib/api-errors.ts` mapping a stable `code` (`INVALID_RANGE`, `RANGE_TOO_LONG`, `ACCESS_NOT_GRANTED`, `BRANCH_FORBIDDEN`, IRIS config errors) to Thai copy; have `apiErrorMessage` return that rather than the raw message. Follow the `alerts-view.ts` precedent: key on the machine-readable field, fall back to a neutral Thai sentence — never a raw interpolation — for unmodelled codes.

**Suggested command:** `/impeccable clarify`

### P2 — Provenance prints three times per page load

**What.** The same four facts render at the header `data-context` (`:246-251`), the `evidence-strip` (`:298-304`), and a third `data-context` inside the summary card (`:326-333`). Only the middle carries the usage-row count.

**Why it matters.** On a phone in LINE — the primary context — that is roughly a screen of duplicate provenance before the first KPI. It also trains the eye to skip provenance chrome, which is the reflex the honesty work needs to overcome.

**Fix.** Collapse to two: header keeps source pill + availability + range; `evidence-strip` takes `fetchedAt` plus the usage-row count. Delete the summary card's third copy — `summary-view.ts:51-64` already gives the summary its own labels.

**Suggested command:** `/impeccable distill`

### P2 — Every branch status pill is hard-coded neutral

**What.** `dashboard.tsx:420`: `<span className="status-pill status-pill--neutral">`. The text is correct, but the class is a literal `--neutral` regardless of ratio, while `machineStatusMeta` (`machine-status.ts:8-35`) maps a meaningful class to every status the twin renders.

**Why it matters.** A branch running 11/12 and one running 1/12 look identical in the status channel. The number is in the text, so this is not strictly color-alone — but on a phone the pill *is* the scannable element, and "which branch needs attention" is the manager's first triage question. **Caveat:** Assessment A's own open question raises whether `running/machines` is a demand signal at all, given it derives from ETL batch arrival rather than live state. If it is a batch artifact, colorizing it would encode a false urgency — relabel it instead. Settle that before coding.

**Fix.** Return a `className` alongside `statusPill` from `branchStatCells`, derived from the same ratio `utilizationView` computes (`dashboard-view.ts:165`). Keep the text unchanged so meaning survives without color.

**Suggested command:** `/impeccable colorize`

### P2 — Floor totals count machines the grid never renders

**What.** `MachineFloor` computes `machines.length` (`:463`), `running` (`:456`) and `knownCycles` (`:455`) over the full list, then renders only washer and dryer groups (`:474-475`); `MachineGroup` returns `null` when empty (`:483`). Any machine whose `machineKind` is neither counts toward `เครื่องทั้งหมด` but renders no card. Separately, `knownCycles` sums only non-null counts and `:465` prints it as a floor total — so one machine of forty having a count presents that machine's cycles as the floor's. `machineKindLabel:158-162` already handles unknown kinds with "ไม่ระบุประเภท", so the code knows the case exists — but no card ever reaches that label.

**Why it matters.** "เครื่องทั้งหมด 24" over a grid of 21 cards is the kind of discrepancy that makes an operator stop trusting every other total on the page.

**Fix.** Add a third `เครื่องประเภทอื่น` group so rendered matches stated, and make `:465` state coverage — `รอบที่นับได้ 12 / 24 เครื่อง`.

**Suggested command:** `/impeccable clarify`

### P2 — No URL state: the working context is unrecoverable and unshareable

**What.** No route in `src/routes/` uses `validateSearch` or `useSearch`. All view state is `useState` (`:165` view, `:166` branchId, `:167` range).

**Why it matters.** Three concrete failures. A LINE user who taps back lands on "last 7 days, all branches" — the manager investigating a complaint cannot get back to it. A desktop refresh loses it. And an owner cannot send "look at สาขา A, last Tuesday" to anyone, removing the fastest path to collaboration the role model implies. Note `e2e/dashboard.pw.ts:16,55` already navigates to `/dashboard?from=…&to=…` against a route that **ignores those params** — latent false confidence in the fixture setup.

**Fix.** Add `validateSearch` (optional strings: `view`, `branch`, `from`, `to`), initialize the three `useState`s from it and sync on change via router navigate, so the URL is the single source of truth. The existing spec then tests something real. A `placeholderData: keepPreviousData` on `dashQuery`/`twinQuery` (`:175`, `:181`) additionally stops the panel blanking on every filter change.

**Suggested command:** `/impeccable adapt`

### P2 — No trend, no comparison, no sort

**What.** All KPIs (`dashboard-view.ts:85-115`) and branch cells (`:128-151`) are absolute totals. No prior-period figure, no sort on the branch grid (`:344-357`) or machine floor (`:468-477`), no date presets — only two free-text inputs. `recentRange` (`:88-100`) hard-codes the 7-day default with nothing to widen from.

**Why it matters.** For an owner, "฿48,200" is not a finding; "฿48,200, down 18% from the prior 7 days" is. AGENTS.md constrains *seasonal and GBM* model claims, but a prior-period delta over an equal-length window is arithmetic, not a model, and is well within what the warehouse supports. Without sort, a manager with 20 branches must read every card.

**Fix.** Add a comparison mode fetching the immediately preceding equal-length window, rendered with an explicit basis label (`เทียบกับ 7 วันก่อนหน้า`), kept as pure subtraction so no modelling claim creeps in. Add presets วันนี้ / 7 วัน / 30 วัน above `:266-282`. Add sort to the branch section.

**Suggested command:** `/impeccable overdrive`

### P3 — Branches error path has no retry, unlike every sibling

`dashboard.tsx:288` renders the branches failure as a bare `error-message`; `:291-295` and `:374` both offer `ลองใหม่`. → `/impeccable polish`

### P3 — The machine drum is decoration carrying two bits of information

`MachineDrum` (`:518-534`) renders a ~96px `aria-hidden` SVG per card; only `running` and `offline` are visually distinct (`styles.css:805-810`, `:837-840`), and the LED at `styles.css:833-835` is unconditionally green — including offline and unknown, the one place color actively contradicts the pill beside it. With 40 machines that is four screens of vertical space. → `/impeccable distill`

### P3 — 89 design-token advisories, all in `styles.css`

The detector found zero issues in the five `.tsx` files (verified true negative, not suppression) and **89 advisory** findings in `styles.css` — 42 color, 24 font-size, 23 radius — each "outside DESIGN.md". `DESIGN.md` exists (17k, 28 Sep), so this is real drift between the written design system and the shipped stylesheet, not detector noise: off-ramp sizes cluster at 10/13/15/16/17/18/20/22/24/26/28px, off-scale radii at 9/11/12/999px, and `styles.css:968` is the only flagged value that also carries `!important`. These are advisory by the tool's contract and do not fail the scan. → `/impeccable document` then `/impeccable harden`

### P3 — Buddhist-calendar output beside Gregorian input

`formatDate`/`formatDateTime` (`:126-143`) call `toLocaleString("th-TH", …)` with no `calendar: "gregory"`. ICU resolves `th-TH` to the **buddhist** calendar, so a range chosen as `2026-09-25 — 2026-10-01` renders as `25 ก.ย. 2569 — 1 ต.ค. 2569`. Defensible as Thai-first, arguably correct for this audience — but it is an implicit default, never reconciled, and it will bite anyone cross-checking a screenshot against a report. → `/impeccable typeset`

### P3 — Dead and hidden affordances

`Tabs.Indicator` is rendered at `:255-256` but `display: none` in `styles.css:285-287`, so the tab affordance is text and background only. `.legend` (`styles.css:892-901`) has no JSX consumer anywhere, while the utilization bar at `:431-439` — which encodes a ratio the user must decode — has no legend at all. → `/impeccable quieter`

### P3 — The `สาขา` KPI's detail names one arbitrary branch

`dashboard-view.ts:110-115` sets the detail to `firstBranchName ?? "ไม่มีข้อมูลสาขา"`. Viewing all branches, a count of 12 is annotated with whichever branch sorted first, which reads as though it identified one. → `/impeccable clarify`

---

## 6. Persona Red Flags

**Franchise owner, on mobile in LINE.** Three repetitions of four facts before any KPI. The owner cannot get back to their context after LIFF remounts, cannot send a view to a manager, and sees `เครื่องทั้งหมด 24` over 21 cards with no explanation. Most seriously, every branch pill is the same neutral colour, so the scan for "which branch needs me" returns nothing. The summary is well built and correctly hidden when empty; the rest of the page does not yet serve the owner's actual question, which is *what changed*.

**Branch manager triaging an alert.** The Dashboard has **no alert surface** — the only `alert` match is `role="alert"` on error containers; alerts live exclusively on Analytics (`:406-437`). So the loop is: alert in LINE → Analytics → Dashboard → Machines, three pages, with branch/date context resetting on each because there is no URL state. The provenance needed to judge whether an alert is real — freshness — is absent from the twin. And the twin card that would confirm machine state asserts "ไม่มีแถว usage" for a machine that has usage rows, so the one page that should confirm the alert actively undercuts it.

**Technician with no revenue access.** The redaction path is genuinely correct — the server nulls revenue (`reporting.ts:26-36`) and the view explains *why* they cannot see it rather than hiding or zeroing. But they cannot act on a bad date range, because `:292` renders English. They cannot distinguish a stale machine from a running one. And the machines with usage but zero counted cycles — precisely the population a technician exists to investigate — are told they have no usage. The technician's tools work; the page tells them the wrong thing at the moment they need it.

---

## 7. Minor Observations

- Six `aria-live="polite"` regions on one page (`:246`, `:298`, plus one per `Tabs.Panel`) re-announce the same provenance on every 60s refetch.
- `fetchJson` and `baht` are duplicated across six and two route files; `formatDate`/`formatDateTime`/`recentRange` across three; four divergent `sourceLabel` implementations, of which the Dashboard's (`:145-149`) returns a *loading* string — "กำลังรอข้อมูลแหล่งที่มา" — for any unrecognized source, where `machines.tsx:70` interpolates honestly.
- `branchStatCells` sets `detail: ""` on all four cells (`:132,138,141,145`), so branch cards carry no provenance where top-level KPIs do.
- `summaryQuery` sets `retry: false` with a comment about empty windows (`:193-196`), but empty-window behaviour is handled client-side by `summaryView` — so `retry: false` actually suppresses retries on transient network failures. The comment and the effect do not correspond.
- `machineKind` is typed `string` throughout, so a new enum member silently falls into the P2 unrendered gap.
- `kpi-card` uses `overflow: hidden` with `min-height: 132px` (`styles.css:568-572`), and the cycles detail at `dashboard-view.ts:99` is the longest string any KPI renders — browser run showed no clipping at 390px, but it is worth a check at the 420px single-column breakpoint.
- **Detector binary reports version `4.0.0` from a cache path named `4.4.0`** — unresolved version skew, worth confirming before trusting the advisories.

---

## 8. Questions to Consider

1. **Should `cycleCountSource` be a two-value or three-value contract?** The binary (`"usage_row" | "unavailable"`) cannot express "rows exist, none counted" — which is precisely what produced the P1. Is zero-counted-cycles a third state the API should own, or should the view derive it from a raw per-machine `usageRows` the API isn't currently sending? The first keeps the honesty decision where the data is; the second keeps the contract small. This is a contract question before it is a design one.
2. **Is the utilization ratio a meaningful metric at all?** It is computed from usage rows, not live state — `dashboard-view.ts:170` already concedes this in its `ariaValueText`. If ETL batch cadence makes `running/machines` an arrival artifact rather than a demand signal, then the neutral tone on every branch pill may be the most honest choice already made, and the fix is to **relabel** the metric, not color-code it. Settle this before the P2 colorize.
3. **How much provenance repetition is intentional?** The three strips may be deliberate defense-in-depth against a stakeholder screenshotting one region out of context. If so the fix is differentiation — make each strip carry a *different* fact — not deletion. Which regions get screenshot-shared in practice?
4. **Does the Dashboard need alerts, or is the Analytics-only split right?** A manager's actual loop spans three pages today, and the server already distinguishes absent / present-but-unwritten / present-with-data for alerts (`alerts-view.ts:1-36`), so an honest alert strip here is cheap. Is the split a deliberate scope boundary or an artifact of which route was built first?

---

## Appendix: Assessment B evidence

**Detector — verified true negative, not a skip.** All five route files return `[]` at exit 0, including a directory pass over all 7 files and a re-run with `--no-config --no-design-system --no-inline-ignores`. Integrity established: no `.impeccable/` config anywhere, no `impeccable-disable` comments in `apps/web/src/`, and a positive-control probe `.tsx` inside the repo (off-palette `#ff00aa`, 13px, 17px) returned 3 findings while the identical file in `/tmp` returned `[]`. Probe deleted; `git status` clean.

**Browser — ran via the repo's Playwright harness, not MCP.** Chrome DevTools MCP failed twice with a profile lock (`The browser is already running for <scratch profile>. Use --isolated…`) and no browser was killed. Evidence was gathered instead through `vite preview` on 4319 with `e2e/support/session.ts` fixture interception — real production bundle, no API, ClickHouse or SQLite. Both a **degraded** (503) and a **populated** (3 branches, long Thai names, 412 cycles, 68% unattributed) state were exercised, because a 503-only run measures the empty shell.

| | 390×844 | 1440×900 |
|---|---|---|
| Horizontal overflow | none (390 == 390) | none (1440 == 1440) |
| Overflowing / clipped elements | 0 / 0 | 0 / 0 |
| `h1` | 26px | 32px |
| Topbar height | 64px | 72px |
| Nav | collapsed to mobile | expanded |
| Console errors / page errors | 0 / 0 | 0 / 0 |

One false positive was caught and correctly **not** reported: a first fixture pass rendered `สถานะข้อมูล: [object Object]` because the fixture supplied an object where `dashboard.tsx:29` types a string and `apps/api/src/index.ts:288` emits `"usage-derived"`. That was the harness's error, not a product defect.
