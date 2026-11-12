# The web UI on HeroUI's own palette, built phone first

**Date:** 2026-11-12
**Commit:** `5fd9018` · image `sha256:62bb92c2…` · deployed as
`laundrytwin:deploy-5fd9018-20261112`
**Status:** live at `https://laundrytwin.duckdns.org`, verified in a browser against
the production bundle, not against a local build.

## What was wrong

Two independent faults, found by reading the stylesheet rather than the screenshots.

**A second design system sat on top of HeroUI.** `src/styles.css` was 2,000 lines: its
own `--ink`/`--canvas`/`--brand` palette, its own `.surface-card`, `.primary-button`
and `.kpi-card` classes, and a `:root { --surface: #ffffff }` that overrode HeroUI's
own `--surface`. Unlayered `:root` beats the library's `@layer base`, so every HeroUI
component rendered in our colours with our spacing. The product was built on HeroUI and
looked like neither HeroUI nor a deliberate alternative.

**Dead utility names.** 38 + 25 + 29 occurrences of `text-small`, `text-tiny`,
`text-default-500`, plus `rounded-medium` and `border-default-200` — all v2 names that
do not exist in v3. They had been rendering as nothing, which is why some labels had no
size at all.

## What replaced it

`src/styles.css` is 140 lines: two imports, the self-hosted Thai subset, three brand
overrides (`--accent`, `--accent-foreground`, `--radius`), one `@layer components`
block of element defaults written with `:where()` so their specificity is zero, and the
measured nav-collapse media queries `e2e/layout.pw.ts` reads. Everything else is the
library's scale.

Pages were rebuilt on `Card`, `Button`, `Chip`, `Tabs`, `Table` and `TextField` over
those tokens. Class names the e2e suite reads (`.app-topbar`, `.kpi-card`,
`.machine-card`, `.trend-line`, `.analytics-section`, …) are kept as hooks on the new
markup, so the suite still measures the same things.

## Mobile first

The pages were desktop-first with `max-[639px]` patches, which is the pattern the
UI/UX Pro Max rule set names for exactly this symptom. On a 390px screen the dashboard
spent its first screen on a title card, a four-control filter panel, a provenance strip
and a caveat; the first number was below the fold.

| change | why |
|---|---|
| fixed bottom bar, four destinations, 20px icons, 52px rows | thumb reach; the hamburger was a two-tap menu for four items |
| layout utilities written mobile-first, enhanced at `min-[640px]`/`md`/`lg` | the compact case is designed rather than subtracted |
| header provenance line and filter helper sentence are `md:` only | both duplicate something the page already says once |
| date fields share a row, labels `sr-only` until `md` | one less row of chrome, still labelled for a screen reader |
| executive summary follows the KPI row | numbers before prose, on both widths |
| KPI cards two-up from 320px, four-up from 768px | a phone was showing one 132px card per row |
| `min-w-[620px]` moved to `md:` on tables | a narrow screen wraps cells instead of hiding a column behind an invisible scroll |

## The summary's numbers

The executive summary was one flat paragraph with a subtitle explaining its origin. The
subtitle duplicated the provenance chips underneath it, and the numbers — the point of
the sentence — looked like every other word.

`summarySegments()` splits the string the server sent and emphasises a part by what it
says, never by position: a count is ink, a `฿` amount is the brand teal, and a number
inside a fragment that talks about a problem (`ข้อมูลสดไม่พร้อม`, `ล่าช้า`,
`ต้องติดตาม`) is amber. The splitter reads text rather than a schema because the summary
can also arrive from IRIS.

Contrast measured against the card's own background in the browser:
counts **17.7:1**, money **6.6:1**, attention **5.7:1** — all above the 4.5:1 the
accessibility rule asks for.

## Evidence

```text
CI        43183407631  completed success
Release   43183717846  completed success
digest    sha256:62bb92c2f9ea7005758d549f0e0c7d5fc806b2633f0cae7ba07a199a8615be58
image     laundrytwin:deploy-5fd9018-20261112   (docker inspect)
APP_IMAGE laundrytwin:deploy-5fd9018-20261112   (/opt/laundrytwin/.env, mode 600)
health    GET https://laundrytwin.duckdns.org/health -> 200
telemetry [telemetry] OTLP export enabled … (content: off)
```

The served chunks were read back from the domain, not assumed: the entry bundle names
`_authenticated-BzgFGINs.js`, that chunk contains `mobile-nav` once and
`mobile-nav-summary` zero times (the old hamburger is gone), and `dashboard-B0CdOCWT.js`
contains `text-warning-soft-foreground` twice and `เรียงจาก` zero times (the removed
subtitle).

A browser run against `https://laundrytwin.duckdns.org/dashboard` with the API answered
from fixtures measured `.mobile-nav` as `display:block, height 58` at 390px and
`display:none` at 1440px.

## Suite

```text
build 0 · check 0
763 API / 330 web / 117 ETL
e2e 56 passed, 9 skipped
  topbar 64px below 640 and 72px above, on the 640 boundary itself
  page-header h1 26px / 32px on the same boundary
  exactly one navigation control at every width in VIEWPORTS
  no horizontal overflow at any width, including 320 and 639
```

## Known gaps

- The bottom bar is 58px with `pb-[env(safe-area-inset-bottom)]`. Measured on a desktop
  viewport where the inset is 0; not yet measured on a notched iPhone.
- Tables wrap rather than restructure on a phone. The wide branch table on the dashboard
  is still a table; a card-per-row version is not built.
- `OTEL_RECORD_CONTENT` remains `0`. The 4,000-character truncation and the
  input/output attributes ship, but nothing is exported until the owner turns it on.
