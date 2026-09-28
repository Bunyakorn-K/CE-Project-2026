# Next Session Handoff — 2026-09-25

> Updated 2026-09-28. The Current State, Verified Locally, and Remaining
> Follow-up Work sections were rewritten to match what the 2026-09-28 session
> actually did; the Production Rollout Gate and Safety Boundaries sections are
> unchanged and still apply. See **Not verified** before crediting anything
> here.

## Current State

LaundryTwin security, reporting, MCP authorization, active web workflows, deployment configuration, and documentation changes are implemented locally. The reviewed checkpoints `2b19a82`, `75c87b6`, `cc57a17`, and `fe118da` are pushed to `origin/main`. This change set performed no deployment, no production migration, and no live machine action, and left the existing VM 117 deployment documented in `README.md` and `docs/02_architecture/deploy-runbook.md` unchanged. The 2026-09-28 session likewise performed no deployment, no production migration, and no live machine action, and pushed nothing. That statement is about what this work did, not about the state of the world: a production deployment does exist.

Working tree was clean at the reviewed checkpoint `fe118da` (current `origin/main` HEAD). It was not clean for most of the 2026-09-28 session and is clean again now. The uncommitted change set that this document originally described — ten modified tracked files plus four tracked files staged for deletion as dead code — has been committed as seven commits, all on `main` and **none pushed**:

| Commit | Subject |
| :--- | :--- |
| `9745d80` | `fix(web,etl,api): browser-QA defect fixes, playground branch scope, ETL clock, seed script` |
| `d8e5af8` | `fix(api): drop nonexistent branch_code from the branch report query` |
| `0a58da1` | `fix(web): collapse nav into the hamburger between 640px and 1019px` |
| `e7d7ff3` | `fix(api,web): stop the dashboard fabricating zeros and split paid from finished` |
| `bed5f3f` | `fix(web): collapse the inline nav below 1041px instead of 1019px` |
| `70f5e5d` | `fix(web): collapse the inline nav below 1171px, not 1041px` |
| `183fbb0` | `test(web): add a Playwright layout regression suite for the shell` |

The dead-code deletion (`apps/web/src/App.tsx`, `apps/web/src/auth-client.ts`, `apps/web/src/dashboard-metrics.ts`, `apps/web/src/dashboard-metrics.test.ts`) is in `eb5dd2a`, which is already pushed. The work described as "still open" later in this document is now largely closed: browser visual QA ran, and the layout behaviour is pinned by a committed test suite. `core.hooksPath` is now set to `.githooks` in this working copy (it was unset, so the gitleaks hooks had not been running); that is local git config and is not committed.

## Verified Locally

### Verified 2026-09-28

Runtime for this run was Node `24.21.0` and pnpm `10.33.4`. Node `24.21.0` is
within the `24` range in `.nvmrc`; pnpm is exact and corepack-enforced by
`packageManager: "pnpm@10.33.4"`. Nothing local narrows the Node range: no
`package.json` declares `engines`, and the Dockerfiles use the floating
`node:24-bookworm-slim` tag.

- `227` tests green: API `152`, web `38`, ETL `37` (up from `180` / `142` /
  `1` / `37` on 2026-09-27)
- `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm check`, `pnpm build`,
  `git diff --check` pass. The `--frozen-lockfile` run matters because the
  Docker build uses it.
- `gitleaks protect --staged --redact` (8.30.1) reports "no leaks found" on
  every commit in this session. `gitleaks` **is** installed here — it was
  installed via brew during this session, having been absent at the
  2026-09-25 checkpoint.
- `core.hooksPath` is now set to `.githooks` in this working copy, so the
  pre-commit and pre-push hooks run. They had not been running before
  (the setting was absent), which is why every commit above ran
  `gitleaks protect --staged --redact` manually instead.
- **Browser QA was performed.** It is no longer pending. The empty-state
  pass, the populated pass, and three layout passes all ran, at 390 / 430 /
  1440 plus a full 320–1920 width sweep. This found and fixed real defects
  rather than confirming assumptions: a nonexistent `branch_code` column that
  made `/machines` and the branch filter return 502; the header horizontal
  overflow; the dashboard's fabricated zeros and its mislabelled machine
  count; the `finished`/`paid` conflation; and an ETL date-expiry time bomb.
- **A local ClickHouse was stood up and seeded** — container
  `laundrytwin-clickhouse-local`, 1,755 usage rows, 2 branches, 6 machines —
  so that populated UI states could be seen for the first time. It was
  verified read-only and was never re-seeded after the initial seed.
- **The layout suite is now committed**: `apps/web/e2e/layout.pw.ts`, 10
  Playwright tests, run with
  `pnpm --filter @laundrytwin/web test:layout`. It needs no API process, no
  ClickHouse, and no SQLite. It is deliberately outside `pnpm test`, so the
  227 figure does not include it. Regression proof: each assertion was
  observed red by reverting the fix it guards, then restored byte-identically
  to `HEAD`.

### Why the previous count read web 1

The `180` / `142` / `1` / `37` figures that this document originally carried
were themselves measured on 2026-09-27, after the dead-code deletion
committed in `eb5dd2a`: `apps/web/src/App.tsx` was unreachable (nothing
imported it, `main.tsx` mounts `router.tsx` → `routeTree.gen.ts`, and none of
its UI strings appeared in `apps/web/dist/`), and it went with
`apps/web/src/auth-client.ts` and the now-removed `dashboard-metrics.ts` plus
its test. That is why web read 1 on 2026-09-27. It is 38 now. Kept so the next
session does not read the jump as a count that was simply edited upward.

### Inherited from checkpoint `fe118da` (2026-09-25), not re-run

These describe the 2026-09-25 checkpoint. A reviewer crediting 2026-09-28 should
not credit them: none was re-run during this session. `tofu` is not installed in
this environment and still cannot be re-run here. (`gitleaks` no longer belongs
on that list — it is installed and was run on every commit.)

- Tofu formatting, validation, and analytics Compose config passed at `fe118da`.
- Local Demo HTTP smoke passed at `fe118da` for health, authentication denial,
  demo session, branch scope, strict date validation, live branch requirement,
  and logout revocation.
- At `fe118da`, `gitleaks dir . --redact` reported two findings in the ignored
  `apps/etl/.env`. **This was not re-checked and is not re-verified now.**
  `apps/etl/.env` does not exist on this machine, so the inherited finding
  cannot be reproduced here and its present status is genuinely unknown.
  Never stage or commit that file, and rotate the values externally if they
  are real.

## Not verified

Every item below is genuinely unverified. Do not let the 227-test figure or
the browser QA imply any of it.

- **No production, staging, or LINE authentication E2E.** The local
  `.env.example:29` ships `VITE_LIFF_ID=` empty and nothing sets it locally, so
  the LINE flow has never been exercised at all. (Only
  `deploy/.env.production.example:19` carries a LIFF ID, and that path was
  never run.)
- **Chromium only.** WebKit and Firefox are untested. Both the manual browser
  QA and the Playwright layout suite ran in Chromium.
- **No CI workflow exists in this repository**, so nothing runs automatically.
  The layout suite in particular only runs when a person runs it.
- `fact_temperature_sample` and `fact_weather_sample` are empty, so the
  temperature and weather UI panels have never been seen populated.
- **`cancelled` cannot be surfaced by the Digital Twin at any date range.**
  `apps/api/src/report/clickhouse-report.ts:84` selects
  `argMax(u.status, u.started_at) AS status`, and every machine's last event is
  `finished`, so the `cancelled` branch is unreachable against real warehouse
  data. Only `finished` is warehouse-verified; `cancelled`, `admitted`, `paid`,
  `running`, and `pending_payment` are covered by unit tests only. The
  `admitted → "เริ่มรอบแล้ว"` label was derived from the enum name alone and has
  never been confirmed against real data or a product decision.
- **No committed screenshot or visual baseline.** The QA screenshots live in
  a temporary directory and will not survive; there is nothing to diff
  against next time.
- `tofu` is not installed, so no IaC validation has run in this session.

### Environment and open items

- Orca desktop automation is still unavailable, but that no longer blocks
  browser work: the browser QA and the Playwright layout suite both ran under
  Playwright/Chromium. There is still **no LINE browser E2E evidence**, and
  no committed screenshot baseline.
- ClickHouse has been intermittently wedging for the whole session. The
  Docker/OrbStack daemon was unresponsive at several points, and the seeded
  `laundrytwin-clickhouse-local` container could not be reached for the later
  commits. Those commits state which numbers were therefore not re-confirmed.
  Do not assume the 1,755-row seed is still there.
- Still open: `docs/05_presentation/build_pptx.py`. All ten imports are referenced and the repository has no Python lint or type-check step, but the original diagnostic could not be observed or cleared here — no Python LSP or type checker is installed in this environment and `python-pptx` is missing, so the module cannot even be imported. A default-config `ruff check` reports four style-only findings (2× B008, 2× ISC004) that no repository verification covers. Recorded here so the next session does not re-triage it blind.

## Recommended Commit And Push

The 2026-09-28 change set is now committed as the seven commits listed under
Current State. **None of them has been pushed.** `origin/main` is still at the
reviewed checkpoint `fe118da`. Pushing is a separate decision that was
deliberately not taken, so the next session should not assume the remote has
any of this work.

Before pushing, or before staging any further change:

1. Inspect `git status --short`, `git diff --stat`, and `git diff --check`.
2. Fetch `origin` and compare the current branch with `origin/main`.
3. Exclude generated or environment files: `.impeccable/`, `.terraform/`,
   `.terraform.lock.hcl`, rendered files, `.env`, `apps/etl/.env`,
   `test-results/`, `playwright-report/`, and `__pycache__/`.
4. Stage reviewed logical groups separately, with an explicit file list. Do not
   use `git add -A` or `git add .`.
5. Run the repository verification and the gitleaks scan after staging. The
   `.githooks` pre-commit hook now does this automatically in clones where
   `core.hooksPath` is set; on a fresh clone run
   `git config core.hooksPath .githooks` first.
6. Review the staged diff and commit messages before creating commits. Push only
   to the intended remote branch; do not force-push.

Do not deploy while committing. Keep future pushes scoped to reviewed changes.

## Production Rollout Gate

LaundryTwin has two deployment tiers: local (env files plus the `dev` run mode) and production on the existing VM (VM 117 in `docs/02_architecture/deploy-runbook.md` → `Topology`). `dev` is a local run mode, not a deployed environment. There is no staging environment.

Follow `docs/02_architecture/deploy-runbook.md` → `Production rollout gate`.

Before any production apply, record:

- approved immutable application ref
- current last-known-good ref for rollback
- backup locations for app SQLite, ETL watermark, and analytics volumes
- required untracked Tofu variables, including `airflow_db_password`

Run `tofu fmt -check`, `tofu validate`, `tofu plan`, and Compose config validation with real target values supplied outside the repository. Review the plan before apply. After apply, run container health checks plus unauthenticated denial, approved-session branch scope, invalid-range, logout, ClickHouse reader, Airflow, Superset, and public TLS smoke checks.

The gate does not authorize the apply. A production deployment, production migration, live telemetry ingestion, machine command, or payment write still requires a separate explicit user request, the recorded rollback ref, and the post-change smoke checks above.

## Remaining Follow-up Work

- [x] Review and commit the reviewed change groups through checkpoint `fe118da`
- [x] Push the reviewed commits to the intended remote branch
- [x] Run browser visual QA at mobile and desktop widths (2026-09-28, Chromium)
- [x] Commit the 2026-09-28 change set as seven commits
- [ ] **Push the 2026-09-28 commits** — `9745d80` through `183fbb0` are local only
- [ ] Verify the LINE flow separately; `VITE_LIFF_ID` is empty, so it has never run
- [ ] Add a CI workflow and wire in `pnpm test`, `pnpm check`, and `test:layout`
- [ ] Extend the layout suite beyond Chromium (WebKit, Firefox)
- [ ] Re-derive the 1172px nav threshold if the dev-bypass owner name or the font
      stack changes; the suite fails loudly by design when it does
- [ ] Seed `fact_temperature_sample` and `fact_weather_sample` so those panels can
      be seen populated at least once
- [ ] Record the production apply details: approved immutable ref, last-known-good rollback ref, and backup confirmation
- [ ] Execute the production rollout gate on the existing VM and record smoke evidence
- [ ] Rotate or revoke the two ignored `apps/etl/.env` findings outside the repository
- [ ] Install or provide an environment containing `python-pptx`, then regenerate `docs/05_presentation/llm-analytics-slides.pptx` and inspect it
- [ ] Re-run full verification after any follow-up code or deployment change

## Safety Boundaries

- Do not modify `raw/` data.
- Do not commit credentials, provider tokens, production databases, customer data, live captures, or local environment files.
- Do not enable `LAUNDRYTWIN_DEV_BYPASS`, demo fallback, revenue MCP access, or public inspector auth bypass in production.
- Do not claim production, LINE, or browser E2E from local tests.
