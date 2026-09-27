# Next Session Handoff — 2026-09-25

## Current State

LaundryTwin security, reporting, MCP authorization, active web workflows, deployment configuration, and documentation changes are implemented locally. The reviewed checkpoints `2b19a82`, `75c87b6`, `cc57a17`, and `fe118da` are pushed to `origin/main`. This change set performed no deployment, no production migration, and no live machine action, and left the existing VM 117 deployment documented in `README.md` and `docs/02_architecture/deploy-runbook.md` unchanged. That statement is about what this work did, not about the state of the world: a production deployment does exist.

Working tree was clean at the reviewed checkpoint `fe118da` (current `origin/main` HEAD) and is not clean now. Ten tracked files carry uncommitted modifications that have not been committed, reviewed, or pushed: `.nvmrc`, `AGENTS.md`, `README.md`, `apps/web/package.json`, `docs/02_architecture/deploy-runbook.md`, `docs/04_traceability/RTM_matrix.md`, `docs/04_traceability/test_cases.md`, `docs/05_presentation/NOTES.md`, `pnpm-lock.yaml`, and this handoff. Four tracked files are staged for deletion as confirmed dead code: `apps/web/src/App.tsx`, `apps/web/src/auth-client.ts`, `apps/web/src/dashboard-metrics.ts`, and `apps/web/src/dashboard-metrics.test.ts`. Review them as one change set before staging. Keep the local `.impeccable/hook.cache.json` ignored and review future changes before staging.

## Verified Locally

### Re-verified 2026-09-27 for this change set

- Runtime for this run was Node `24.21.0` and pnpm `10.33.4`. Node `24.21.0` is
  within the `24` range in `.nvmrc`; pnpm is exact and corepack-enforced by
  `packageManager: "pnpm@10.33.4"`. Nothing local narrows the Node range: no
  `package.json` declares `engines`, and the Dockerfiles use the floating
  `node:24-bookworm-slim` tag. CI reads `.nvmrc` via `node-version-file`.
- `180` tests green: API `142`, web `1`, ETL `37` (after the dead-code deletion)
- `pnpm test`, `pnpm check`, `pnpm build`, API `build:prod`, `git diff --check` pass
- Diagnostic triage re-run 2026-09-27 against the uncommitted set. `apps/web/src/App.tsx` was unreachable dead code: nothing imported it, `main.tsx` mounts `router.tsx` → `routeTree.gen.ts`, and none of its distinctive UI strings appeared anywhere in `apps/web/dist/`. It has now been deleted together with `apps/web/src/auth-client.ts` (its only importer pair), so its diagnostic leaves with the file; the web `better-auth` dependency it was the sole consumer of is removed and `pnpm-lock.yaml` is regenerated. `apps/web/src/dashboard-metrics.ts` and its test went with it, which is why web is now 1 test. `apps/api/src/analytics/routes.test.ts` is clean: every import is referenced, `pnpm --filter @laundrytwin/api check` exits 0, and the API test run passes it (21 files, 142 tests).

### Inherited from checkpoint `fe118da` (2026-09-25), not re-run for this change set

These describe the 2026-09-25 checkpoint. A reviewer crediting 2026-09-27 should
not credit them: none was re-run here, and `tofu` and `gitleaks` are not
installed in this environment, so they cannot be re-run here.

- Tofu formatting, validation, and analytics Compose config passed at `fe118da`.
- Local Demo HTTP smoke passed at `fe118da` for health, authentication denial,
  demo session, branch scope, strict date validation, live branch requirement,
  and logout revocation.
- At `fe118da`, `gitleaks dir . --redact` reported two findings in the ignored
  `apps/etl/.env`. That was not re-checked: `gitleaks` is not installed here,
  and `apps/etl/.env` does not exist on this machine, so the inherited finding
  cannot be reproduced here and its present status is unknown. Never stage or
  commit that file, and rotate the values externally if they are real.

### Environment and open items

- Orca desktop automation is unavailable in this environment; no browser
  screenshots or LINE/browser E2E evidence exists
- Still open: `docs/05_presentation/build_pptx.py`. All ten imports are referenced and the repository has no Python lint or type-check step, but the original diagnostic could not be observed or cleared here — no Python LSP or type checker is installed in this environment and `python-pptx` is missing, so the module cannot even be imported. A default-config `ruff check` reports four style-only findings (2× B008, 2× ISC004) that no repository verification covers. Recorded here so the next session does not re-triage it blind.

## Recommended Commit And Push

Commit and push are appropriate after final review because the next session needs a remote checkpoint. The reviewed checkpoint is now pushed to `origin/main`; the ten modified and four deleted files listed under Current State are the next review target, and pushing them still requires review and normal pre-push scanning.

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
- [ ] Record the production apply details: approved immutable ref, last-known-good rollback ref, and backup confirmation
- [ ] Execute the production rollout gate on the existing VM and record smoke evidence
- [ ] Rotate or revoke the two ignored `apps/etl/.env` findings outside the repository
- [ ] Run browser visual QA at mobile and desktop widths; verify LINE flow separately
- [ ] Install or provide an environment containing `python-pptx`, then regenerate `docs/05_presentation/llm-analytics-slides.pptx` and inspect it
- [ ] Re-run full verification after any follow-up code or deployment change

## Safety Boundaries

- Do not modify `raw/` data.
- Do not commit credentials, provider tokens, production databases, customer data, live captures, or local environment files.
- Do not enable `LAUNDRYTWIN_DEV_BYPASS`, demo fallback, revenue MCP access, or public inspector auth bypass in production.
- Do not claim production, LINE, or browser E2E from local tests.
