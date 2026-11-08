# Drop `fact_temperature_sample_pre_dedup` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the obsolete 2026-09-30 dedup rollback table only after an explicit live backup, recheck both row counts, and verify the production warehouse stays healthy.

**Architecture:** This plan has one destructive production migration. It adds a dry-run shell contract that refuses unless the rollback and live row counts match the immutable 2026-09-30 baseline, then executes only `deploy/analytics/drop-temperature-pre-dedup.sql`, then proves ETL, warehouse freshness, and the public app remain healthy. Production writes and any restore attempt require the human's explicit go-ahead.

**Tech Stack:** Bash, ClickHouse HTTP, Docker host shell on VM 117, existing PostgreSQL/Airflow freshness DAG.

**Spec:** `docs/04_traceability/ops-verification-2026-09-30-temperature-dedup-migration.md` §§2–3, 5–7; `docs/03_data_contracts/data_contracts.md` Temperature Sample row.

## Global Constraints

- Do not run the drop until fresh host verification plus a ClickHouse backup both succeed.
- `fact_temperature_sample_pre_dedup` and `fact_temperature_sample` have same warehouse schema but different row counts; do not compare names or drop by wildcard.
- A fresh backup is the rollback target after this drop; the dropped table is not itself the rollback target after execution.
- Never upload, export, or commit production customer data.
- Node and pnpm versions are fixed by the repo; no application code change is needed in this plan.
- If row counts differ from the baseline or ETL is not current, abort without reporting success.

## Review Focus

- **Unexpected live-table row count:** refuse if the live table does not contain the frozen 2,258,219-row baseline, because a silent change can indicate the wrong database or a failed migration.
- **Rollback table already absent:** distinguish missing table from zero rows and stop, because `IF EXISTS` alone could make a no-op look successful.
- **Backup silently equals an old tarball:** verify backup completion and freshness in the backup output, not merely file existence.
- **Fresh-but-broken warehouse:** verify both row count and latest `extracted_at` after the drop, because the plan specifically prevents a healthy-looking but truncated table from being accepted.
- **Residual references:** a warehouse metadata search must return no `fact_temperature_sample_pre_dedup` occurrence after successful drop.

---

### Task 1: Add a refusal-safe verifier and dry-run gate

**Files:**
- Create: `deploy/analytics/verify-temperature-dedup.sh`
- Test: `deploy/analytics/verify-temperature-dedup.test.sh`

**Interfaces:**
- Consumes: environment variables `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE`.
- Produces: shell functions `temperature_dedup_counts`, `assert_temperature_dedup_counts`, `assert_temperature_dedup_freshness`, and `assert_rollback_table_dropped`.
- Exit code `0` means every asserted property holds; nonzero means the caller must not proceed.

- [ ] **Step 1: Write failing tests**

```bash
test_count_mismatch_refuses
test_rollback_missing_refuses
test_stale_live_table_refuses
test_correct_counts_pass
test_drop_absence_marker_passes
```

- [ ] **Step 2: Run the tests and confirm failure**

```bash
bash deploy/analytics/verify-temperature-dedup.test.sh
```

Expected: FAIL with missing verifier functions.

- [ ] **Step 3: Implement the verifier**

Implement `temperature_dedup_counts` using two JSON queries:

```sql
SELECT count() AS live_rows FROM fact_temperature_sample FINAL;
SELECT count() AS rollback_rows FROM fact_temperature_sample_pre_dedup;
```

Implement `assert_temperature_dedup_counts` with these exact thresholds:

```bash
live_rows == 2258219 && rollback_rows == 3762139
```

Implement freshness using:

```sql
SELECT toString(max(extracted_at)) FROM fact_temperature_sample;
```

and require that value to be at most 30 minutes before `SELECT toString(now())`.

Implement `assert_rollback_table_dropped` by querying `system.tables` and requiring zero rows matching `fact_temperature_sample_pre_dedup`.

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
bash deploy/analytics/verify-temperature-dedup.test.sh
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add deploy/analytics/verify-temperature-dedup.sh deploy/analytics/verify-temperature-dedup.test.sh
git commit -m "feat(ops): add refusal-safe verification for temperature dedup drop"
```

### Task 2: Add a backup gate outside the SQL migration

**Files:**
- Create: `deploy/analytics/backup-clickhouse.sh`
- Test: `deploy/analytics/backup-clickhouse.test.sh`

**Interfaces:**
- Consumes: environment variables from Task 1, `BACKUP_TARGET_DIR`, and `BACKUP_NAME`.
- Produces: shell function `create_clickhouse_backup()` and a marker file named `$BACKUP_NAME.done`.
- `create_clickhouse_backup()` must invoke ClickHouse native backup syntax against `BACKUP_TARGET_DIR`; the caller must not use `fact_temperature_sample_pre_dedup` as the only rollback copy.

- [ ] **Step 1: Write failing tests**

```bash
test_missing_backup_dir_fails
test_successful_backup_writes_marker
test_failed_backup_writes_no_marker
```

- [ ] **Step 2: Run the tests and confirm failure**

```bash
bash deploy/analytics/backup-clickhouse.test.sh
```

Expected: FAIL with missing backup helper.

- [ ] **Step 3: Implement the helper**

The function must:

1. Create `BACKUP_TARGET_DIR` with `mkdir -p`.
2. Run `BACKUP DATABASE $CLICKHOUSE_DATABASE TO Disk('backup', '$BACKUP_NAME')` via the ClickHouse HTTP client.
3. Check that `system.backups` reports the backup `status = OK`.
4. Write `$BACKUP_TARGET_DIR/$BACKUP_NAME.done` only after the previous checks pass.

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
bash deploy/analytics/backup-clickhouse.test.sh
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add deploy/analytics/backup-clickhouse.sh deploy/analytics/backup-clickhouse.test.sh
git commit -m "feat(ops): add ClickHouse backup gate for dedup cleanup"
```

### Task 3: Execute the production drop after gates pass

**Files:**
- Modify: `deploy/analytics/drop-temperature-pre-dedup.sql`
- Create on VM 117 only: `/opt/backups/clickhouse/pre-drop-temperature-pre-dedup-<UTC-timestamp>.done`

**Interfaces:**
- Consumes: Tasks 1–2; SQL must contain exactly one `DROP TABLE IF EXISTS laundrytwin_analytics.fact_temperature_sample_pre_dedup` statement.
- Produces: absent rollback table and fresh post-drop row counts.

- [ ] **Step 1: Request explicit human go-ahead**

State the backup target, expected live and rollback counts, and abort conditions. Continue only after an explicit go-ahead.

- [ ] **Step 2: Create the live backup and store the marker**

```bash
CLICKHOUSE_DATABASE=laundrytwin_analytics \
BACKUP_TARGET_DIR=/opt/backups/clickhouse \
BACKUP_NAME=pre-drop-temperature-pre-dedup-$(date -u +%Y%m%dT%H%M%SZ) \
bash deploy/analytics/backup-clickhouse.sh
```

Expected: `$BACKUP_TARGET_DIR/$BACKUP_NAME.done` exists and the backup reports `status = OK`.

- [ ] **Step 3: Run the verifier before the drop**

```bash
CLICKHOUSE_DATABASE=laundrytwin_analytics \
bash deploy/analytics/verify-temperature-dedup.sh assert_counts
CLICKHOUSE_DATABASE=laundrytwin_analytics \
bash deploy/analytics/verify-temperature-dedup.sh assert_freshness
```

Expected: live rows `2258219`, rollback rows `3762139`, and freshness lag `<= 30` minutes.

- [ ] **Step 4: Execute only the drop SQL**

```bash
clickhouse-client --database laundrytwin_analytics --multiquery < deploy/analytics/drop-temperature-pre-dedup.sql
```

Expected: command exits `0`.

- [ ] **Step 5: Verify post-drop state**

```bash
CLICKHOUSE_DATABASE=laundrytwin_analytics \
bash deploy/analytics/verify-temperature-dedup.sh assert_dropped
CLICKHOUSE_DATABASE=laundrytwin_analytics \
bash deploy/analytics/verify-temperature-dedup.sh assert_freshness
```

Expected: metadata search returns zero tables, live rows remain `2258219`, lag `<= 30` minutes.

- [ ] **Step 6: Verify ETL and app health**

```bash
sudo docker logs laundrytwin-etl-1 --tail 20
sudo docker exec analytics-clickhouse-1 clickhouse-client \
  --database laundrytwin_analytics \
  --query "SELECT count(), max(extracted_at), dateDiff('minute', max(extracted_at), now()) FROM fact_machine_usage"
curl -s http://127.0.0.1:8787/health
```

Expected: `ETL complete` with current `max(extracted_at)`, app health returns `{"ok":true}`.

- [ ] **Step 7: Update the handoff record**

Mark the drop complete in `docs/07_handoffs/2026-09-30-handoff-priorities.md`, including the backup marker, post-drop row counts, freshness lag, and the fact that the dropped table is no longer a rollback target.

- [ ] **Step 8: Commit the handoff update**

```bash
git add docs/07_handoffs/2026-09-30-handoff-priorities.md
git commit -m "docs(ops): record fact_temperature_sample_pre_dedup drop"
```
