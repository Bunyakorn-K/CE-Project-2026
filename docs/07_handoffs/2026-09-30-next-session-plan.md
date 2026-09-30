# Next Session Handoff — 2026-09-30

> Supersedes `2026-09-25-next-session-plan.md` for anything about production,
> the warehouse, or the deployment. Read **Read This First** before anything
> else: the cause of the 17-day warehouse hole is now **known**, and it is not
> a copy failure — it was a rollback to a stale backup, preceded by deleting the
> correct one.
>
> This session's work is committed as `e3198e4` (32 files) and is **not
> pushed**. Every production figure below carries its measurement date. Nothing
> here re-confirms the cycle-KPI decision or explains the Airflow restarts; both
> are recorded as weaker than the surrounding docs imply.

## Read This First

**The root cause is resolved. The data was never deleted — it was orphaned.**

`analytics-clickhouse-1` OOM-crash-looped **2,779 times** from 2026-09-14
05:56 to 2026-09-17 10:10 (15 host OOM kills, `global_oom`). A 3 GiB memcap and a
4 GiB `/swapfile` stopped the loop but did not make the live volume healthy. On
2026-09-17 the operator:

1. **10:16:37** — took a **correct full backup** of the live volume
   (`docker volume create chdata-bak-20260917` + `alpine cp -a /src/. /dst/`).
2. **10:31:55 – 10:32:03** — **deleted that backup** (`rm -rf`, `docker volume rm`).
3. **10:32:03** — extracted `/opt/backups/pre-upgrade-20260831/clickhouse-data.tgz`
   (cut at **2026-08-31 04:32**) into a new volume
   `analytics_clickhouse-data-restored`, which is **still the live volume today**.
4. **10:42:18** — switched compose to it. The original `analytics_clickhouse-data`
   was orphaned, still holding 2026-08-31 04:32 → 2026-09-16.

The 17 days were **never lost from disk** — the stale volume still holds them,
byte-identical, 7,848,770,665 bytes. The warehouse pointer was simply moved to a
snapshot taken before those days existed.

The proof is a fingerprint in the data: 2026-08-31 splits **exactly at the
04:32 tarball cutoff** — 35 rows before it (00:10:44 → 04:28:47, never lost) and
134 after it (04:45:47 → 21:14:24, from the 2026-09-30 merge), leaving a
17-minute hole straddling the cutoff. The next usage row is 2026-09-17 01:55:33.

> **Correction to an earlier claim in this handoff.** The two volumes'
> `fact_machine_usage` lineages are **not** unrelated. Both carry the same
> Atomic table UUID `store/390/390b1d99-94e6-49df-b489-c0a3893c9cfa`; only the
> *part names* differ, because merge boundaries differ. Comparing part names is
> not comparing lineage. Compare **table UUID and part offset range** instead.

**Still unknown:** *why* ClickHouse would not stay up on the live volume even
with the memcap and swap. The error log the operator captured for exactly this
(`/opt/analytics/ch-logs/`, via the throwaway `chtest3`) is now an empty
directory. No record exists of why a 17-day-old tarball was accepted as a
restore source.

Detail, evidence and confidence levels:
`docs/04_traceability/ops-verification-2026-09-30-warehouse-data-recovery.md` §1.

> ### Standing rule
>
> **Another restore could lose a different window — differently.** The cause is
> known. Detection now exists (`check_usage_continuity`, added 2026-09-30); the
> restore-time gates do not. The specific failure was **deleting a
> correct backup 8 seconds before extracting an older one in its place.** Before
> any future restore, volume swap, or host migration: assert the restore source
> is **not older** than the data it replaces, and compare source/destination
> lineage by table UUID and part offset range — **a matching server UUID proves
> nothing**.

## Current State

Committed at `e3198e4` on `main`, 32 files. `e3198e4` and this handoff are
**unpushed**; `origin/main` is at `7409f5f`. Count with
`git log --oneline origin/main..HEAD` rather than trusting a number written
here — this document is itself one of those commits, so any count it states is
already stale by one.

`tofu` runs on the target host and does `git fetch` +
`reset --hard origin/${app_repo_ref}` (`deploy/tofu/checkout.tf:28-31`), then
rsyncs from that checkout. Local work is therefore inert until it is merged
**and pushed**.

`tofu apply` has **never been run on this VM**: no `terraform.tfvars`, no
`*.tfstate` anywhere in the repo, and the deployment is hand-managed. The repo
config is now a faithful record of the host, but a first apply would be a
first-ever provisioning run, not a routine deploy.

### What this session did

1. **Closed a 17-day hole in the production warehouse** — recovered and
   inserted 2,617 `fact_machine_usage` rows, 205,857
   `fact_temperature_sample` rows, and 22 `started_at IS NULL` rows. The stale
   volume was never mutated (size 7,848,770,665 bytes and server UUID identical
   before and after; `analytics-clickhouse-1` was never restarted).
2. **Fixed the `tofu` landmine** — `stacks.tf` rsyncs with `--delete` over
   `/opt/analytics`, so an apply would have destroyed production state. The repo
   now matches the measured host and a real pre-apply deletion gate exists.
3. **Refreshed documentation** — current-state figures re-measured with inline
   dates; historical verification records left intact.

### The `tofu` landmine fix, specifically

- ClickHouse volume declared `external` under its **real** name.
- `clickhouse-memory.xml` added (3 GiB cap). It exists because the host
  OOM-killed on 2026-09-16 and produced 502s.
- Superset uses the `superset_app` role; `superset_db_password` variable added;
  `*.bak-*` excluded from the sync.
- Real deletion gate: `deploy/tofu/scripts/analytics-rsync.sh` +
  `analytics-rsync.excludes` + `analytics-delete-allowlist.txt`. It dry-runs
  the identical `rsync -a --delete --itemize-changes`, prints every
  `*deleting` path, and **refuses** the sync unless each one is allowlisted.
  A refusal exits non-zero and aborts the apply before the `.env` is installed
  and before `docker compose up -d`, so a refused sync leaves the running stack
  untouched. `analytics-delete-allowlist.txt` is **deliberately empty** so the
  first gate run stops and prints what it wants to delete. Allowlist entries are
  exact paths, never globs.

## Measured — 2026-09-30 11:39:11 UTC, real production warehouse

Do **not** re-derive these. They are already in the repo with this date, in
`docs/04_traceability/ops-verification-2026-09-30-warehouse-data-recovery.md`
and `docs/04_traceability/RTM_matrix.md`. Re-measure only if you are about to
quote them again later than this date.

`fact_machine_usage` (FINAL):

| Fact | Value |
|---|---|
| Rows FINAL | **7,908** (`countDistinct(tenant_id, branch_id, usage_id)` also 7,908 — no key collision) |
| Rows raw, non-`FINAL` | 7,911 |
| `started_at IS NULL` | 533 |
| `machine_session_id IS NULL` | **5,369 = 67.8933%** (was 65.25% of 5,146 on 2026-09-29, 63.91% of 4,458 earlier that day) |
| `attribution_state` | 2,540 `exact` / 5,368 `pending_attribution` |
| `min(started_at)` / `max(started_at)` | 2026-07-22 07:15:57.214 / 2026-09-30 11:28:07.611 |
| Canonical cycle KPI `countIf(status IN ('paid','finished'))` | **6,666** |
| `sum(amount_satang)` | all rows 33,617,000; paid/finished 32,265,000 |
| `countDistinct(machine_session_id)` | 2,539 |
| `status` | `pending_payment` 2, `paid` 262, `admitted` 28, `running` 972, `finished` 6,404, `cancelled` 240 |
| Day coverage | **70 of 71** day buckets. **2026-07-27 is the only usage gap day, and it is a genuine source gap**, not a merge artefact. All 17 recovered days have rows. |

Price band at this measurement — **this is not a re-confirmation of the cycle
definition, it is the opposite**:

| definition | count | ฿/cycle |
|---|---:|---:|
| session-distinct paid/finished | 1,589 | ฿203.05 |
| `countDistinct` no filter | 2,539 | ฿127.08 |
| **row count paid/finished — canonical** | **6,666** | **฿48.40** |
| `count()` no filter | 7,908 | ฿42.51 |

Other tables at the same measurement: `fact_temperature_sample` 3,760,465 rows
/ 2,256,545 distinct keys → **1,503,920 duplicate excess** (pre-existing, **not
fixable in place** — plain `MergeTree`, needs a table rewrite that has not been
done; `FINAL` does not help). `fact_weather_sample` 196 rows.

Provenance rule from the recovery record §6: figures with a file behind them are
re-checkable; most of the table above does **not** have one (it came from a
read-only `SELECT` pass), so it is re-measurable but not re-readable. A future
merge changes these numbers and nothing on disk will say so.

## Open Items

### PRIORITY 1 — root cause RESOLVED; detection CLOSED; restore-time guards still open

**Closed.** The 2026-09-17 procedure is read and recorded in the recovery record
§1. It was a rollback to `pre-upgrade-20260831/clickhouse-data.tgz` after the
correct `chdata-bak-20260917` volume was deleted.

- [x] **Make the freshness DAG detect mid-range holes, not just staleness.**
      **Done 2026-09-30.** `check_usage_continuity` now runs first in
      `deploy/analytics/dags/laundrytwin_warehouse_freshness.py` and counts day
      buckets of `toDate(started_at)` — the business day, deliberately not
      `extracted_at`, which is the field that stayed fresh throughout the
      incident. It warns rather than fails, and exempts only the
      evidence-backed `2026-07-27` source gap. Verified against the live
      warehouse in the real Airflow 3.3.1 image: clean on the recovered data,
      and flags exactly 2026-09-01 … 2026-09-16 when fed the real pre-recovery
      day set. Method and evidence: recovery record §1.6.

What remains is **prevention at restore time**, not diagnosis:

- [ ] **Restore-source freshness gate.** A restore must refuse a source backup
      older than the destination it replaces. A `stat` comparison would have
      blocked this one.
- [ ] **Post-restore continuity assertion before any compose switch.** Compare
      `max(extracted_at)` in the restored volume against the pre-restore value.
      The DAG check above is a *detector* on a 5-minute cadence; this is a
      *gate* at the moment of the swap, and the two are not substitutes.
- [ ] **Reconcile the ETL watermark against warehouse coverage.** The watermark
      is a forward-only source cursor on the host
      (`/opt/laundrytwin-etl/data/etl-watermark.json`), outside the ClickHouse
      volume, so a volume rollback is invisible to the loader by construction.
      The contiguity check *reports* this; it does not make the loader re-read
      the gap.

### PRIORITY 2 — the canonical cycle-KPI decision lost its most intuitive support

The 2026-09-29 decision chose `countIf(status IN ('paid','finished'))` partly
because on that corpus it read ฿42.20, inside the plausible ฿40–45 band for a
Thai self-service wash. After the merge it reads **฿48.40, above the band** —
and the only definition now inside the band is the unfiltered `count()` the repo
has already rejected as a cycle count (it includes cancelled, admitted, and
running work).

**The ranking is unchanged and the decision stands on its 2026-09-29 evidence.**
It is simply weaker than the RTM's framing implies. The RTM and the recovery
record already say this; do not restate it as re-confirmed.

#### Both open questions below were measured on 2026-09-30 12:15–12:45 UTC

Full method, SQL and per-group figures:
`docs/04_traceability/ops-verification-2026-09-30-warehouse-data-recovery.md`
**§5A**. Read that before re-deriving anything here.

**1. The unattributed-recovered-days hypothesis: CONFIRMED.**

| group | rows | `machine_session_id IS NULL` | % unattributed |
|---|---:|---:|---:|
| **A — the 17 recovered days** (2026-08-31 … 09-16) | 2,644 | 1,922 | **72.6929%** |
| **B — the complement** (all other dated rows) | 4,743 | 2,930 | **61.7752%** |
| C — `started_at IS NULL` (cannot be assigned to a day) | 534 | 524 | 98.1273% |

The recovered days **are** materially more unattributed than the pre-existing
corpus — a gap of 10.92 percentage points — and they supply **95.01%** of their
own `paid`/`finished` rows as unattributed against the complement's **66.35%**.

**The mechanism is a row-MIX effect, not a PRICE effect, and that distinction
matters.** Revenue per unattributed `paid`/`finished` row is **6,306 satang
(฿63.06)** in the recovered days against **6,273.4 satang (฿62.73)** in the
complement — a 0.5% difference. The two periods cost the same per cycle. What
differs is how much of each period's row count is revenue-bearing, so blending
a 95%-unattributed block into a 66%-unattributed corpus raises the blended
฿/cycle.

Per group, under the canonical row count: recovered days alone **฿59.92**,
complement alone **฿41.88** (inside the band), all rows **฿48.41**. A
counterfactual that reassigns the recovered days' rows to the complement's
attribution mix, holding each group's own observed revenue-per-row, reads
**฿43.05 — inside the plausible band.** The overshoot above ฿45 is fully
accounted for by attribution mix and by nothing else measured here.

**2. The 1:1 session cardinality: RE-MEASURED, still exactly 1:1.**

Run by hand with `status` filtered **by name**, per the correction below;
`apps/api/scripts/cycle-cardinality-diagnostic.ts` was neither run nor
modified. 12:20:17 UTC: 2,544 session ids, min = max = avg = **1** rows per
session. 12:41:59 UTC: 2,545 session ids, **0** carrying more than one status,
**0** carrying more than one paid/finished status, max distinct statuses = 1.
**The property the 2026-09-29 decision rests on survives the enum migration and
the merge.**

> **What this does and does not mean for the decision.** It does **not**
> re-confirm it. The ฿/cycle agreement is now *explained* — and what it
> explains is that the ratio reads like a plausible wash partly **because
> unattributed rows are cheap per session**, not because a row is a wash. A
> metric that lands in the band for that reason has not thereby been validated.
> The decision is **weaker** than the RTM's framing implies, not stronger, and
> should not be described as re-confirmed.
>
> Two things this measurement explicitly does **not** explain: the
> 2026-07-22 → 2026-08-20 block is only **6.53%** unattributed and reads
> **฿3.35/cycle**, which is why the corpus-wide unattributed share (67.87%) is
> lower than the recovered days' own — that block is unexplained and is not
> recovered data; and whether **฿63 per unattributed cycle** is a *correct*
> wash price is untested, because this only shows the two periods agree on it.

- Remember the unattributed share is a **live metric, not a constant**. It moves
  as the ETL ingests the IRIS backlog and as recovery merges land. Any figure
  quoted without a measurement date is stale by construction. It visibly moved
  **during** this measurement: the §"Measured" table above read 7,908 rows at
  11:39:11 UTC and **7,921** rows by 12:45 UTC.

> **Correction to a common assumption:** `apps/api/scripts/cycle-cardinality-diagnostic.ts`
> **will refuse to run against the production warehouse.** Its candidate
> expressions are frozen on the *pre-migration* Enum8 numbering
> (`status IN (2, 4)` = paid + finished). The production migration HAS been run
> (2026-09-29), so the live column is the IRIS lifecycle order and the script's
> enum guard exits with `ENUM_VERSION_REFUSAL_REASON` and measures nothing. That
> refusal is deliberate and correct. To re-measure cardinality, run the queries
> **by hand against the migrated warehouse with `status` filtered by name** —
> `buildSessionSpanSummarySQL` is status-free and can be used verbatim; in
> `buildMultiStatusSessionSQL` replace `status IN (2, 4)` with
> `status IN ('paid','finished')`. Do not "fix" the frozen expressions; they
> are the evidence. **This is now done — see item 2 above; the working queries
> are recorded in the recovery record §5A.8.**

- Remember the unattributed share is a **live metric, not a constant**. It moves
  as the ETL ingests the IRIS backlog and as recovery merges land. Any figure
  quoted without a measurement date is stale by construction.

### PRIORITY 3 — `SUPERSET_DB_PASSWORD` is in this session's transcript and was deliberately NOT rotated

The user chose to defer. **Treat it as compromised.** It is live and in use by
Superset. Its value came from `/opt/analytics/.env`.

`ANALYTICS_READ_API_KEY` also leaked in the same transcript but is **confirmed
dead** — deleting it from the `.env` neutralises it, and the next apply removes
it automatically.

Rotate outside the repository, with a rollback target and a post-rotation
health check.

### PRIORITY 4 — three unexplained container restarts

On 2026-09-30, `analytics-airflow-scheduler-1`,
`analytics-airflow-triggerer-1` and `analytics-airflow-dag-processor-1` each
restarted once during the merge window:

| Fact | Value |
|---|---|
| Window | ~11:02–11:05Z |
| `RestartCount` / `ExitCode` / `OOMKilled` | 1 / 0 / false |
| Host free memory at the time | 838 MiB — attributable to a throwaway ClickHouse copy this session created |
| DAG behaviour | `laundrytwin_warehouse_freshness` ran `state=success` continuously before, during and after |

**The trigger was never determined and must not be recorded as benign.** Clean
exits, no OOM kill, and no missed DAG run mean operational impact appears nil,
but "appears nil" is not a cause. `dmesg` is empty on the host.
`apt-daily.timer` last fired 11:01:28Z — suggestive, unproven.

**Still-open items carried over from the 2026-09-25 handoff, NOT touched this
session:**

- [ ] `X-Dash-Token` — 49 hex chars embedded in the Caddyfile on the Pi at site
      `incomes.n.home.arpa`, and copied into ~57 backup files in the same
      directory. The site is private (not internet-exposed) but the value has
      appeared in transcripts.
- [ ] `clickhouse_password` Airflow Variable — a ClickHouse credential in
      plaintext in the Airflow metadata DB, i.e. a **third** copy alongside
      `/opt/analytics/.env` and `/opt/laundrytwin-etl/.env`. No repo or tofu
      resource manages it.
- [ ] `chtest7` — an exited `clickhouse-server:26.3` container (exit 76) still
      mounting the 7.6 GB `analytics_clickhouse-data` volume. **Now identified:
      created 2026-09-17 10:30:45 as the last of a series of diagnostic
      throwaways during the OOM crash loop** (see **Read This First**). It is
      evidence for the §1 timeline; its `docker logs` and `docker inspect` are
      quoted there, so it can now be removed.
- [ ] Permissions on `/opt/backups/pre-upgrade-20260831/*.tgz` — mode 0644,
      should be 0600.
- [ ] The registry is on the same host as its only client (`10.10.0.117:5000` is
      the VM's own eth0), so it cannot protect against host loss.
- [ ] Commit attribution — the most recent commits, including `e3198e4`, are
      attributed to `uunw` rather than `Bunyakorn-K`, because the SSH key belongs
      to `uunw@golem`.

## Verified Locally

### Verified 2026-09-30

- **384 tests green — API 270, web 53, ETL 61** (up from 227 / 152 / 38 / 37 on
  2026-09-28).
- `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm check`, `pnpm build`,
  `git diff --check` pass.
- The **Playwright layout suite is 11 tests** and is deliberately **outside**
  `pnpm test`: `pnpm --filter @laundrytwin/web test:layout`. The 384 figure does
  not include it.
- CI now exists and is not new to this session:
  `.github/workflows/{ci,codeql,dependency-review,gitleaks}.yml`.

```bash
pnpm install --frozen-lockfile
pnpm test          # 384 green (API 270, web 53, ETL 61)
pnpm check
pnpm build
pnpm --filter @laundrytwin/web test:layout   # 11 tests, separate from pnpm test
gitleaks protect --staged --redact
git diff --check
```

### Verified against production 2026-09-30 (after the merge)

- **401 unauthenticated on all five endpoints**: `/api/me`,
  `/api/report/dashboard`, `/api/twin`, `/api/report/branches`,
  `/api/admin/grants`.
- The **ETL watermark is advancing** — not stalled, not rewound.
- `laundrytwin_warehouse_freshness` reports `state=success` on every scheduled
  run 04:00Z → 11:30Z, spanning the merge window.

That is endpoint-level and scheduler-level evidence only. It is consistent with
a successful merge; **it is not a functional test of the product.**

## Not verified

Every item below is genuinely unverified. Do not let the 384-test figure or the
health checks imply any of it.

- **No production, LINE, or browser E2E.** Nothing establishes that the
  Dashboard or Digital Twin renders correctly in a browser against the merged
  warehouse. The LINE authentication flow has never run end to end.
- **The data loss is now understood** (PRIORITY 1, closed 2026-09-30) — but
  **why ClickHouse would not start on the live volume after the memcap and swap
  remain unknown**; the error log captured for it is gone. The contiguity check
  added on 2026-09-30 would *report* a resulting hole, but nothing prevents the
  startup failure itself.
- **The Airflow restart trigger is undetermined** (PRIORITY 4) — not benign.
- **Why ฿/cycle moved from ฿42.20 to ฿48.40 was not established** (PRIORITY 2).
  **RESOLVED 2026-09-30 12:45 UTC — hypothesis CONFIRMED.** It is a row-mix
  effect: the recovered days are 72.6929% unattributed vs the complement's
  61.7752%, at the same revenue per unattributed cycle (6,306 vs 6,273.4
  satang). At the complement's mix the same data reads ฿43.05. See PRIORITY 2
  and the recovery record §5A. **This weakens rather than strengthens the
  cycle-KPI decision.**
- **Still unexplained:** why the 2026-07-22 → 2026-08-20 block is only 6.53%
  unattributed and reads ฿3.35/cycle, and whether ฿63 per unattributed cycle
  is a correct wash price at all.
- **Most §"Measured" figures have no captured output file.** They are
  re-measurable but not re-readable.
- **`tofu apply` has never been run on this VM.** A first apply is a
  provisioning run.
- `fact_machine_event` is still empty, so **Digital Twin state is still
  usage-derived**, not live telemetry.
- `fact_temperature_sample` has 1,503,920 duplicate rows that `FINAL` does not
  remove; any `count()` over it counts reads, not distinct readings.
- Chromium only for the layout suite; no WebKit or Firefox.

## Operational Facts

These cost real time to discover. Do not re-derive them.

**SSH.** `ssh -J dietpi@dietpi uunw@172.30.191.48` is the **only** route.
`10.10.0.117:22` is firewalled, the Mac has no ZeroTier, the VM has no Tailscale
client. Hostname `laundrytwin`, passwordless sudo. Always use
`-o UserKnownHostsFile=<throwaway>` under the approved temp dir and delete it;
**never touch `~/.ssh/known_hosts`**. Tailscale on the bastion has asked for
interactive re-auth before — if it does, the user must approve it. Do not work
around it.

**Local dev ClickHouse.** `orb start`, then
`docker start laundrytwin-clickhouse-local`. 127.0.0.1:8123, user `default`,
password `laundrytwin-local`, database `laundrytwin_analytics`.

**Traps that produce wrong conclusions:**

- The API listens on **8787**, not 8788. 8788 refuses connections.
- `docker compose restart` does **not** re-read `env_file` — `--force-recreate`
  is required.
- "Up 7 days" in docker output is **host** uptime, not container health.
- Exit 137 is not always OOM. Last time it was a plain `docker stop`.
- `ETL_SINCE_FALLBACK_DAYS` default in `deploy/tofu/variables.tf:215-218` is
  **30**, not 0. **Do not delete the ETL watermark** — falling back to a 30-day
  window on a plain-`MergeTree` temperature table inserts permanent duplicates.
- **Never run `OPTIMIZE TABLE ... FINAL` on `fact_machine_usage`** — it would
  rebuild the attached `proj_by_time` projection. The `proj_by_time` projection
  must be dropped for the status-enum swap and rebuilt after it, and the ETL held
  still for the window (`deploy/etl/hold-etl-for-warehouse-migration.sh`).
  That migration **HAS been run**; do not re-run
  `apps/api/scripts/migrate-usage-status-enum.ts --apply` — it refuses an
  already-migrated column by design.
- `fact_machine_usage.status` is `pending_payment=1, paid=2, admitted=3,
  running=4, finished=5, cancelled=6`. **Filter it by name, never by number.**

**Credential topology.** API → ClickHouse `reader`; ETL + weather → ClickHouse
`etl_writer`; Superset → Postgres `superset_app`; Airflow → Postgres `airflow`;
maintenance → ClickHouse `admin` (rotated, unused by any service).

**When anything touches ClickHouse, check volume identity** (`CreatedAt` +
size) to confirm the volume was not reinitialised.

## Security Warning

Credentials have leaked into agent transcripts **five times** in this project.

The specific trap: **`grep <KEY_NAME>` against a `.env` matches the line that
DEFINES the value and prints the value.** Extract key **names** only:

```bash
cut -d= -f1 /opt/analytics/.env        # names only, never values
```

or look a value up into a shell variable and use it without echoing.

`clickhouse-client` run **inside** the clickhouse container picks up
`CLICKHOUSE_PASSWORD` from that container's own env, so no `--password` is ever
needed.

**Do not redact secrets with regex — use an allowlist of key names.** A regex
redaction over an unknown-shaped secret either leaks it or mangles the output
you needed to read.

## Backups — DO NOT TOUCH

- **`/opt/backups/pre-deploy-20260929/`** — pre-deploy, restore-verified (the
  ClickHouse export was successfully restored into a throwaway container).
- **`/opt/backups/pre-merge-20260930/`** — mode 0700. Contains
  `01-merge-result.txt` (340 lines: full command record and pre/post counts),
  `merge_predicate.txt` (the rollback recipe), the staged Native files, and
  `_phase2/` evidence.
  - **The staged Native files are the only record of what was inserted. Do not
    delete them.**
  - The temperature rollback predicate also matches **95 pre-existing live
    rows**, so a predicate rollback would delete rows that were never part of
    the merge. **A whole-table restore is the cleaner rollback path** for that
    table. Prefer it.

## Recommended Commit And Push

This handoff is committed on top of `e3198e4` and pushed with it. Check with
`git log --oneline origin/main..HEAD` rather than trusting a count written here.

Before pushing, or before staging any further change:

1. `git status --short`, `git diff --stat`, `git diff --check`.
2. Fetch `origin` and compare the current branch with `origin/main`.
3. Exclude generated or environment files: `.impeccable/`, `.terraform/`,
   `.terraform.lock.hcl`, rendered files, `.env`, `apps/etl/.env`,
   `test-results/`, `playwright-report/`, `__pycache__/`.
4. Stage reviewed logical groups separately, with an explicit file list. **Do
   not use `git add -A` or `git add .`.**
5. Run the verification and the gitleaks scan after staging. The `.githooks`
   pre-commit hook does this automatically where `core.hooksPath` is set; on a
   fresh clone run `git config core.hooksPath .githooks` first.
6. Review the staged diff and commit messages before committing. Push only to
   the intended remote branch; **do not force-push**.

Pushing is not deployment. A deployment, production migration, or live machine
action requires a separate explicit user request, a recorded rollback ref, and
the smoke checks below.

## Production Rollout Gate

LaundryTwin has two deployment tiers: local (env files plus the `dev` run mode)
and production on the existing VM 117
(`docs/02_architecture/deploy-runbook.md` → `Topology`). `dev` is a local run
mode, not a deployed environment. **There is no staging environment** and no
staging rollout should be planned.

Follow `docs/02_architecture/deploy-runbook.md` → `Production rollout gate`.

Because `tofu apply` has never run on this VM, the **first** apply is a
provisioning run. It needs a `terraform.tfvars` built from the live `.env`
values **without echoing them**, and `analytics-delete-allowlist.txt` is
deliberately empty so the deletion gate stops and prints what it wants to
delete. Read that print before approving anything.

Before any production apply, record: approved immutable application ref;
current last-known-good ref for rollback; backup locations for app SQLite, ETL
watermark, and analytics volumes; required untracked tofu variables.

Run `tofu fmt -check`, `tofu validate`, `tofu plan`, and Compose config
validation with real target values supplied outside the repository.

After any production change, verify **for real** — a green container is not
verification:

- all five endpoints return **401** unauthenticated: `/api/me`,
  `/api/report/dashboard`, `/api/twin`, `/api/report/branches`,
  `/api/admin/grants`;
- the ETL watermark **advances**;
- the `laundrytwin_warehouse_freshness` Airflow DAG actually reports
  **`state=success`**, not merely a green container;
- ClickHouse volume identity (CreatedAt + size) is unchanged.

The gate does not authorize the apply.

## Remaining Follow-up Work

- [x] ~~**Read the 2026-09-17 restore procedure and establish how the live
      volume lost 2026-08-31 → 2026-09-16.** Compare block lineage, not server
      UUID.~~ **CLOSED 2026-09-30** — resolved: a rollback to the 2026-08-31
      04:32 tarball, after the correct `chdata-bak-20260917` volume was deleted
      8 seconds earlier. The data was orphaned, never destroyed. See **Read This
      First** and the recovery record §1. Note this also **corrects** the
      earlier "block lineages are unrelated" claim — the Atomic table UUID is
      identical; only part names differ.
- [ ] Add the restore-source freshness gate and post-restore continuity
      assertion described in PRIORITY 1 (not implemented; the detection half
      landed on 2026-09-30, the restore-time gates did not)
- [x] Make `laundrytwin_warehouse_freshness` detect mid-range day-bucket holes,
      not only staleness — done 2026-09-30 as `check_usage_continuity`; see
      recovery record §1.6
- [x] Measure `machine_session_id` / `attribution_state` for 2026-08-31 …
      2026-09-16 specifically, to confirm or refute the ฿48.40 explanation —
      **DONE 2026-09-30 12:15–12:45 UTC. CONFIRMED**: 72.6929% unattributed vs
      the complement's 61.7752%; a row-mix effect, not a price effect. See
      PRIORITY 2 and the recovery record §5A
- [x] Re-measure 1:1 session cardinality on the migrated warehouse, by name,
      not with the frozen diagnostic script — **DONE 2026-09-30 12:20/12:41
      UTC. Still exactly 1:1** (min = max = 1 rows per session; 0 sessions with
      more than one status). Queries in the recovery record §5A.8
- [ ] Determine the Airflow restart trigger; do not record it as benign
- [ ] Rotate `SUPERSET_DB_PASSWORD` (compromised, in a transcript, in use)
- [ ] Remove `ANALYTICS_READ_API_KEY` from `/opt/analytics/.env`
- [ ] Rotate `X-Dash-Token` on the Pi and scrub the ~57 backups
- [ ] Rotate or remove the `clickhouse_password` Airflow Variable (third copy)
- [ ] Remove the `chtest7` container (mounts the 7.6 GB stale volume)
- [ ] `chmod 0600 /opt/backups/pre-upgrade-20260831/*.tgz`
- [ ] Registry off-host, or accept the loss window in writing
- [ ] Fix commit attribution (`Bunyakorn-K`, not `uunw`)
- [ ] Add a CI workflow step or runbook entry for the layout suite if not
      already covered by `.github/workflows/ci.yml`
- [ ] Extend the layout suite beyond Chromium (WebKit, Firefox)
- [ ] Rewrite `fact_temperature_sample` to drop 1,503,920 duplicates (table
      rewrite + swap; `FINAL` does not work)
- [ ] Build a `terraform.tfvars` from the live `.env` **without echoing values**,
      then a first `tofu plan` — never an apply without the explicit request
- [ ] Verify LINE E2E separately; production and browser E2E remain unverified
- [ ] Push `e3198e4` and this handoff (`origin/main` is at `7409f5f`)
- [ ] Re-run full verification after any follow-up code or deployment change

## Safety Boundaries

- Do not treat the 2026-09-30 recovery as a fix. The cause is now known
  (a rollback to a stale backup after the correct one was deleted). A detector
  exists as of 2026-09-30, but **no gate prevents a repeat at restore time** —
  see PRIORITY 1.
- Do not re-confirm the cycle-KPI decision with the 2026-09-30 band. It stands
  on 2026-09-29 evidence and is now weaker, not stronger.
- Do not record the 2026-09-30 Airflow restarts as expected or benign.
- Do not restate pre-merge figures as current (4,458 / 5,146 rows; ฿42.20; 63.91%
  / 65.25% unattributed). Quote a figure only with its measurement date.
- Do not filter `status` by ordinal; it is renumbered to the IRIS lifecycle order.
- Do not modify `raw/` data.
- Do not commit credentials, provider tokens, production databases, customer
  data, live captures, or local environment files. Do not print a secret while
  diagnosing one.
- Do not delete anything under `/opt/backups/`.
- Do not enable `LAUNDRYTWIN_DEV_BYPASS`, demo fallback, revenue MCP access, or
  public inspector auth bypass in production.
- Do not claim production, LINE, or browser E2E from local tests.
