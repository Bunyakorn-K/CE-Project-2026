# Documentation map

**Read this to find the right file fast.** `AGENTS.md` and `README.md` are the
entry points; this is the index they point to.

## If you only read one thing

[`07_handoffs/2026-09-30-handoff-priorities.md`](07_handoffs/2026-09-30-handoff-priorities.md)
— the ranked list of what is left, with the evidence record named per item.
Start there, then follow its links.

## Where each fact lives

Facts that change should be stated in **one** file. This table is that map.

| Fact | Single source of truth | Do not restate it in |
|---|---|---|
| Usage row count, day coverage, unattributed share | [`06_ml/ml-training-data-guide.md`](06_ml/ml-training-data-guide.md) §5, §9.1 | anywhere else — quote as "roughly 8,000 rows over roughly 70 days" and link |
| Warehouse table schemas and the `status` enum | [`03_data_contracts/data_contracts.md`](03_data_contracts/data_contracts.md) + `apps/etl/src/schema.ts` | docs; the code is authoritative |
| Gas sensor fields, units, safety boundary | [`03_data_contracts/ha_gas_sensor_contract.md`](03_data_contracts/ha_gas_sensor_contract.md) | anything that presents gas as a safety system |
| Runnable ClickHouse queries | [`03_data_contracts/gas-pressure-queries.sql`](03_data_contracts/gas-pressure-queries.sql) | — |
| Test count | [`AGENTS.md`](../AGENTS.md) §Verification | other docs |
| Requirement → function mapping | [`04_traceability/RTM_matrix.md`](04_traceability/RTM_matrix.md) | — |
| Deployment topology, TLS, troubleshooting, **LINE LIFF login configuration** | [`02_architecture/deploy-runbook.md`](02_architecture/deploy-runbook.md) | — |
| Engineering rules and change workflow | [`AGENTS.md`](../AGENTS.md) | — |

**Why this rule exists.** The usage row count was stated in twelve files and
moved four times in one day. README sat two revisions behind while `AGENTS.md`
carried the current figure, and a reader trusting the older file got a wrong
answer with no way to tell. A live number repeated in N places is not
redundancy, it is a countdown.

Two exceptions, both deliberate:

- **Dated evidence records** (`04_traceability/ops-*`, `07_handoffs/`) keep
  their own figures. A record of what was measured on a given day must not be
  retro-edited, or it stops being evidence. They are labelled with their date.
- **A constraint outlives its number.** Saying "about two thirds of rows carry
  no session id" does not retire the rule that a cycle count must never be
  presented as fully attributed. Rules are restated where they are enforced.

## By directory

### `01_requirements/` — what the project must do

| File | Purpose |
|---|---|
| [`system_requirement.md`](01_requirements/system_requirement.md) | requirements v2 |
| [`house_of_quality.md`](01_requirements/house_of_quality.md) | **CE handbook layer: CR → TC → QR** (customer-facing chain) — bridge to `system_requirement.md` / RTM |
| [`system_functions.md`](01_requirements/system_functions.md) | functional decomposition |
| [`user_stories.md`](01_requirements/user_stories.md) | user stories |
| [`cost-analysis.md`](01_requirements/cost-analysis.md) | self-hosting cost estimate |

### `02_architecture/` — how it is built and deployed

| File | Purpose |
|---|---|
| [`deploy-runbook.md`](02_architecture/deploy-runbook.md) | **topology, TLS, rollout gate, troubleshooting, LINE LIFF scopes.** Read before any deploy, and before any LINE sign-in failure |
| [`er-diagram-implementation.md`](02_architecture/er-diagram-implementation.md) | ER diagram of what is actually implemented |
| [`data-and-activity-diagrams.md`](02_architecture/data-and-activity-diagrams.md) | target MVP data and activity flows |
| [`use-case-sequence-diagrams.md`](02_architecture/use-case-sequence-diagrams.md) | use case and sequence diagrams |
| [`backoffice-consolidation-design.md`](02_architecture/backoffice-consolidation-design.md) | backoffice UI consolidation design |

### `03_data_contracts/` — fields, units, semantics

| File | Purpose |
|---|---|
| [`data_contracts.md`](03_data_contracts/data_contracts.md) | **main warehouse field rules and constraints** |
| [`ha_gas_sensor_contract.md`](03_data_contracts/ha_gas_sensor_contract.md) | **gas/pressure contract + the safety boundary** |
| [`gas-pressure-queries.sql`](03_data_contracts/gas-pressure-queries.sql) | runnable queries, all executed against production |
| [`modbus_frame_analysis.md`](03_data_contracts/modbus_frame_analysis.md) | Modbus register evidence |

Read these before changing schemas, MQTT parsing, KPIs, alerts, or API
contracts.

### `04_traceability/` — evidence and verification

Requirements mapping:

| File | Purpose |
|---|---|
| [`RTM_matrix.md`](04_traceability/RTM_matrix.md) | requirement → function → evidence |
| [`test_cases.md`](04_traceability/test_cases.md) | test case documentation |
| [`roadmap-2026-09.md`](04_traceability/roadmap-2026-09.md) | remaining work plan |

Ops records, most recent first:

| File | What it establishes |
|---|---|
| [`ops-verification-2026-11-09-line-delivery.md`](04_traceability/ops-verification-2026-11-09-line-delivery.md) | two real LINE messages accepted by LINE with `delivered_at` set, the cooldown proven by a second sweep (`cooldown: 2, sent: 0`), and the credential gap that preceded it |
| [`ops-verification-2026-11-09-gas-trend-production.md`](04_traceability/ops-verification-2026-11-09-gas-trend-production.md) | **R06 closed**: the production DAG log that carries the gas verdict, the two bugs production found in code whose tests passed, and why R05 still cannot notify |
| [`ops-verification-2026-11-09-app-deploy-and-sweep-finding.md`](04_traceability/ops-verification-2026-11-09-app-deploy-and-sweep-finding.md) | the first deploy of a CI-published image, the six-minute outage that came with it, and the **503 that proves the alert engine has no data source in production** |
| [`ops-verification-2026-11-09-ci-publish-ghcr.md`](04_traceability/ops-verification-2026-11-09-ci-publish-ghcr.md) | the publish path moved to GHCR on the run's own token, one secret left (`VITE_LIFF_ID`), and the guard that refuses to publish an image with LINE compiled out |
| [`ops-verification-2026-11-09-warehouse-backup-scheduled.md`](04_traceability/ops-verification-2026-11-09-warehouse-backup-scheduled.md) | the warehouse's first automated backup: three helper defects that made every call refuse, the daily timer, and a **restore of the first backup** that matched the live tables; same-host only |
| [`ops-verification-2026-11-09-ml-dataset-and-candidates.md`](04_traceability/ops-verification-2026-11-09-ml-dataset-and-candidates.md) | R09: the guide's numbers re-measured, `fact_ml_features` built (456 NULLs = the gap day), four candidates vs seasonal-naive, **adopt none** |
| [`ops-verification-2026-11-09-ai-audit.md`](04_traceability/ops-verification-2026-11-09-ai-audit.md) | R08/F-07: AI tool calls audited with digests, a real `/api/ai/chat` call's rows quoted, two latent defects fixed |
| [`ops-verification-2026-11-09-gas-trend-evaluation.md`](04_traceability/ops-verification-2026-11-09-gas-trend-evaluation.md) | R06: the gas trend decision and its evidence; the gate corrected to the edge rate by a production measurement; **no sweep has run** |
| [`ops-verification-2026-11-09-alert-sweep-scheduled.md`](04_traceability/ops-verification-2026-11-09-alert-sweep-scheduled.md) | R05: the sweep route and DAG built and tested; **not deployed, R05 still open** |
| [`ops-verification-2026-09-30-warehouse-data-recovery.md`](04_traceability/ops-verification-2026-09-30-warehouse-data-recovery.md) | the 17-day hole, the 2026-09-17 rollback, and **the two still-missing restore-time guards.** Read §1 before any restore, backup, volume swap, or host migration |
| [`ops-verification-2026-09-30-postgres-cluster-reinit-forensics.md`](04_traceability/ops-verification-2026-09-30-postgres-cluster-reinit-forensics.md) | Airflow restarts are Postgres cluster reinitializations. 59 of them. Trigger still unidentified |
| [`ops-verification-2026-09-30-temperature-dedup-migration.md`](04_traceability/ops-verification-2026-09-30-temperature-dedup-migration.md) | 3,762,139 → 2,258,219, and why a reload from IRIS was impossible |
| [`ops-verification-2026-09-30-gas-collector-deploy.md`](04_traceability/ops-verification-2026-09-30-gas-collector-deploy.md) | the gas collector deploy, the grant step, the `gas_detector_*` exclusion |
| [`ops-verification-2026-10-02-source-coverage-audit.md`](04_traceability/ops-verification-2026-10-02-source-coverage-audit.md) | **the 68 "missing" usage days are not missing and cannot be backfilled**; the `2026-07-27` exemption's stated reason was false; `2026-06-17` is permanently unrecoverable and no check covers it |
| [`ops-incident-2026-09-14-clickhouse-lock.md`](04_traceability/ops-incident-2026-09-14-clickhouse-lock.md) | ClickHouse restart loop. **Its fix block writes to a volume — do not run it as a volume procedure** |
| [`f12-weather-evaluation-2026-09-07.md`](04_traceability/f12-weather-evaluation-2026-09-07.md) | first weather/usage correlation evaluation |
| [`ops-verification-2026-09-14-r09-offpeak.md`](04_traceability/ops-verification-2026-09-14-r09-offpeak.md) | `get_off_peak_windows` MCP tool |
| [`ops-verification-2026-09-14-librechat-tools.md`](04_traceability/ops-verification-2026-09-14-librechat-tools.md) | LibreChat MCP wiring |
| [`ops-verification-2026-09-13-airflow-superset.md`](04_traceability/ops-verification-2026-09-13-airflow-superset.md) | Airflow + Superset bring-up |
| [`ops-verification-2026-09-06.md`](04_traceability/ops-verification-2026-09-06.md), [`-09-09.md`](04_traceability/ops-verification-2026-09-09.md) | early VM and infrastructure verification |
| [`ops-verification-2026-11-10-dependabot-remediation.md`](04_traceability/ops-verification-2026-11-10-dependabot-remediation.md) | 76 Dependabot alerts to 0 (3 critical), and the zod pin Dependabot could not see because the runtime image installs outside the lockfile |
| [`ops-verification-2026-11-10-collector-release-coverage.md`](04_traceability/ops-verification-2026-11-10-collector-release-coverage.md) | weather/gas had no update path (2 of 4 compose services were in the release matrix); both published and redeployed, and `.env` no longer records images four deploys behind |
| [`ops-verification-2026-11-10-line-rich-menu-roles.md`](04_traceability/ops-verification-2026-11-10-line-rich-menu-roles.md) | four rich menus, one per role, linked on login; images rendered with Chrome because Pillow cannot shape Thai; the `api-data.line.me` 404 |

### `05_presentation/` — [`NOTES.md`](05_presentation/NOTES.md)

Presentation build notes and evidence.

### `06_ml/` — models and training data

| File | Purpose |
|---|---|
| [`ml-training-data-guide.md`](06_ml/ml-training-data-guide.md) | **the canonical row count and attribution figures.** Feature schema, pipeline, phases A–D |
| [`algorithm-comparison.md`](06_ml/algorithm-comparison.md) | which algorithm, and why |

### `07_handoffs/` — where work stands

| File | Status |
|---|---|
| [`2026-09-30-handoff-priorities.md`](07_handoffs/2026-09-30-handoff-priorities.md) | **current.** Start here |
| [`2026-09-30-next-session-plan.md`](07_handoffs/2026-09-30-next-session-plan.md) | superseded, corrections noted inline |
| [`2026-09-25-next-session-plan.md`](07_handoffs/2026-09-25-next-session-plan.md) | superseded |

### `integration/` — [`iris-laundrytwin-read-api.md`](integration/iris-laundrytwin-read-api.md)

The current optional IRIS read-only integration. It does not override the CE
requirements or the data contracts.

### `superpowers/` — historical, not authority

`plans/` and `specs/` are implementation evidence from earlier work. Useful for
understanding why something is shaped a certain way. **They are not current
product authority** — where they conflict with `AGENTS.md`, the requirements,
or a dated ops record, they are wrong and should be treated as history.

## App-level documents

| File | Purpose |
|---|---|
| [`apps/web/PRODUCT.md`](../apps/web/PRODUCT.md) | web users, workflows, Thai-first principles |
| [`apps/web/DESIGN.md`](../apps/web/DESIGN.md) | web design system |
| [`apps/etl/README.md`](../apps/etl/README.md) | ETL configuration |
| [`deploy/etl/README.md`](../deploy/etl/README.md) | ETL deployment |
| [`deploy/tofu/README.md`](../deploy/tofu/README.md) | OpenTofu infrastructure |
| [`deploy/registry/README.md`](../deploy/registry/README.md) | internal registry |

## Things that will mislead you

- **The gas table has no machine or usage key.** It cannot be joined to
  `fact_machine_usage` on a machine identity. Any query that appears to do so
  is joining on something else.
- **The 2026-09-14 ClickHouse incident fix block writes to a volume.** It is a
  crash-loop writeup, not a volume-recovery procedure.
- **A dated ops record is not current state.** Figures in `04_traceability/ops-*`
  describe their own date. Reading one as current is how the project ended up
  with three different row counts in one day.
- **Volume identity is not table identity.** Two ClickHouse volumes can share
  the same Atomic table UUID, and part *names* differ legitimately across merge
  boundaries. Comparing part names is not comparing lineage.
