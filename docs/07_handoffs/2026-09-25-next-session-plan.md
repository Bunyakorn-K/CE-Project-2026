# Next Session Handoff — 2026-09-25

## Current State

LaundryTwin security, reporting, MCP authorization, active web workflows, deployment configuration, and documentation changes are implemented locally. The reviewed checkpoint is committed locally as `2b19a82`; no push, staging deployment, production migration, or live machine action has been performed.

Working tree is intentionally dirty and contains broad existing changes. Preserve unrelated changes and review every path before staging.

## Verified Locally

- Node `24.13.0`, pnpm `10.33.4`
- `181` tests green: API `142`, web `2`, ETL `37`
- `pnpm test`, `pnpm check`, `pnpm build`, API `build:prod`, `git diff --check` pass
- Tofu formatting, validation, and analytics Compose config pass
- Local Demo HTTP smoke passes for health, authentication denial, demo session, branch scope, strict date validation, live branch requirement, and logout revocation
- Orca desktop automation is unavailable in this environment; no browser screenshots or LINE/browser E2E evidence exists
- Editor/LSP diagnostics remain in `apps/web/src/App.tsx`, `apps/api/src/analytics/routes.test.ts`, and `docs/05_presentation/build_pptx.py`; verify whether each is pre-existing or introduced by this work before committing
- `gitleaks dir . --redact` still reports two findings in ignored `apps/etl/.env`; never stage or commit that file, and rotate the values externally if they are real

## Recommended Commit And Push

Commit and push are appropriate after final review because the next session needs a remote checkpoint. The reviewed checkpoint is now committed locally; push only after the remote branch and approval are confirmed.

1. Inspect `git status --short`, `git diff --stat`, and `git diff --check`.
2. Fetch `origin` and compare the current branch with `origin/main` before staging.
3. Review the large rename/deletion set under `docs/superpowers/` and the replacement LaundryTwin-named files.
4. Exclude generated or environment files: `.impeccable/`, `.terraform/`, `.terraform.lock.hcl`, rendered files, `.env`, `apps/etl/.env`, and `__pycache__/`.
5. Stage reviewed logical groups separately. Suggested commit boundaries:
   - API/auth/reporting/MCP and focused tests
   - Web routes, styles, and web tests
   - Deployment, Tofu, Compose, and environment examples
   - Requirements, architecture, traceability, integration, presentation source, and this handoff
6. Run the repository verification and `gitleaks` again after staging.
7. Review the staged diff and commit messages before creating commits. Push only to the intended remote branch; do not force-push.

Do not push until the remote branch and approval are confirmed. Do not deploy while committing.

## Staging Gate

Follow `docs/02_architecture/deploy-runbook.md` → `Staging rollout gate`.

Before any staging apply, record:

- staging host and data boundary
- approved immutable application ref
- current last-known-good ref for rollback
- backup locations for app SQLite, ETL watermark, and analytics volumes
- required untracked Tofu variables, including `airflow_db_password`

Run `tofu fmt -check`, `tofu validate`, `tofu plan`, and Compose config validation with real target values supplied outside the repository. Review the plan before apply. After apply, run container health checks plus unauthenticated denial, approved-session branch scope, invalid-range, logout, ClickHouse reader, Airflow, Superset, and public TLS smoke checks.

Production deployment, production migration, live telemetry ingestion, machine commands, and payment writes remain outside this gate and require separate explicit approval.

## Remaining Follow-up Work

- [x] Review and commit the current logical change groups
- [ ] Push the reviewed commits to the intended remote branch
- [ ] Provide staging host, approved ref, rollback ref, and backup confirmation
- [ ] Execute the staging rollout gate and record smoke evidence
- [ ] Rotate or revoke the two ignored `apps/etl/.env` findings outside the repository
- [ ] Run browser visual QA at mobile and desktop widths; verify LINE flow separately
- [ ] Install or provide an environment containing `python-pptx`, then regenerate `docs/05_presentation/llm-analytics-slides.pptx` and inspect it
- [ ] Re-run full verification after any follow-up code or deployment change

## Safety Boundaries

- Do not modify `raw/` data.
- Do not commit credentials, provider tokens, production databases, customer data, live captures, or local environment files.
- Do not enable `LAUNDRYTWIN_DEV_BYPASS`, demo fallback, revenue MCP access, or public inspector auth bypass in production.
- Do not claim staging, LINE, browser, or production E2E from local tests.
