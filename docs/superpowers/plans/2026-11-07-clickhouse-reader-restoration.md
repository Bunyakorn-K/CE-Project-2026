# ClickHouse Reader Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the least-privilege `reader` user in ClickHouse so `/api/report/branches` and `/api/report/dashboard` return 200 again.

**Architecture:** Fix the mount source on VM 117 by restoring the repository's `clickhouse-reader.xml` file (not a directory) with the existing `CLICKHOUSE_READER_PASSWORD` environment value preserved, then recreate the ClickHouse container and prove `reader` appears in `system.users`, can read `dim_branch`, and the API returns data. Add a regression test that fails if the compose mount for reader ever targets a directory or host path.

**Tech Stack:** Docker Compose, ClickHouse 26.3, Bash, existing `deploy/analytics/clickhouse-reader.xml`, existing `deploy/analytics/compose.yaml`.

**Spec:** `deploy/analytics/clickhouse-reader.xml` (reader definition), `docs/03_data_contracts/data_contracts.md`, AGENTS.md engineering invariants (server-enforced authorization, parameterized queries, no committed credentials).

## Global Constraints

- Do not upload, export, or commit production customer data.
- Never print or commit `CLICKHOUSE_READER_PASSWORD`; the existing VM value must remain unchanged.
- Do not widen the `reader` grants beyond `SELECT ON laundrytwin_analytics.*`; `admin` remains reserved for ETL and controlled operations.
- Do not touch the live warehouse volume; the fix is config/mount only, no data migration.
- Every container recreate requires a fresh backup of the warehouse volume first (same tar mechanism as the pre-drop backup) and explicit human go-ahead before `docker compose up`.
- A directory mount that hides a config file is a hard failure; `docker compose config` must show reader.xml as a file, not a directory.

## Review Focus

- **Missing reader user:** `SELECT name FROM system.users` must include `reader` after recreate, because every report route depends on it.
- **Wrong password env:** `CLICKHOUSE_READER_PASSWORD` missing or stale in the container env makes auth fail with 516 even if the XML loads; verify env is present but never print its value.
- **Stale error attribution:** after fix, a 401/403 must come from the API scope logic, not from ClickHouse auth failure; `REVENUE_FORBIDDEN`/`BRANCH_FORBIDDEN` codes prove the API reached the correct layer.
- **Directory-vs-file mount regression:** a future compose edit that maps a directory over the reader XML path must fail the regression test, because that exact shape caused this outage.
- **Silent wrong-source fallback:** verify `/api/report/branches` returns `source: clickhouse` and non-empty branch list, not an error envelope.

---

### Task 1: Restore the host mount source and recreate ClickHouse

**Files:**
- Modify on VM 117 only: `/opt/analytics/clickhouse-reader.xml` (replace empty directory with the file)
- Create on VM 117 only: `/opt/backups/clickhouse-pre-reader-restoration-<UTC-timestamp>.tgz`

**Interfaces:**
- Host file `/opt/analytics/clickhouse-reader.xml` must be a regular file with the `<reader>` user defined by the repository file.
- Container mount: `/opt/analytics/clickhouse-reader.xml:/etc/clickhouse-server/users.d/reader.xml:ro`.
- Post-condition: `system.users` contains `reader` and `reader` can `SELECT count() FROM dim_branch FINAL`.

- [ ] **Step 1: Request explicit human go-ahead**

State the backup target, the directory-vs-file root cause, and that the recreate does not touch the warehouse volume. Continue only after explicit go-ahead.

- [ ] **Step 2: Back up the warehouse volume**

```bash
BACKUP_NAME=pre-reader-restoration-$(date -u +%Y%m%dT%H%M%SZ)
sudo tar -czf /opt/backups/clickhouse-$BACKUP_NAME.tgz \
  -C /var/lib/docker/volumes/analytics_clickhouse-data-restored/_data .
sudo ls -lh /opt/backups/clickhouse-$BACKUP_NAME.tgz
```

Expected: archive exists and is non-trivially sized.

- [ ] **Step 3: Replace the empty directory with the repository file**

```bash
sudo rm -rf /opt/analytics/clickhouse-reader.xml
sudo cp deploy/analytics/clickhouse-reader.xml /opt/analytics/clickhouse-reader.xml
sudo ls -la /opt/analytics/clickhouse-reader.xml
```

Expected: regular file, 1808 bytes, containing `<reader>`.

- [ ] **Step 4: Verify the reader password env is present (without printing it)**

```bash
sudo docker inspect analytics-clickhouse-1 --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -c '^CLICKHOUSE_READER_PASSWORD='
```

Expected: `1`.

- [ ] **Step 5: Recreate only ClickHouse**

```bash
sudo docker compose -f /opt/analytics/compose.yaml up -d --force-recreate clickhouse
```

Expected: `analytics-clickhouse-1` starts and becomes `healthy` within 60s.

- [ ] **Step 6: Prove the reader user and its one grant**

```bash
sudo docker exec analytics-clickhouse-1 clickhouse-client \
  --query "SELECT name FROM system.users"
sudo docker exec analytics-clickhouse-1 clickhouse-client \
  --database laundrytwin_analytics \
  --query "SELECT count() FROM dim_branch FINAL"
```

Then as `reader`:

```bash
sudo docker exec analytics-clickhouse-1 clickhouse-client \
  --database laundrytwin_analytics --user reader \
  --password "$CLICKHOUSE_READER_PASSWORD" \
  --query "SELECT count() FROM dim_branch FINAL"
```

Expected: `reader` appears in `system.users`; each SELECT returns `3`.

- [ ] **Step 7: Prove the API answers from ClickHouse**

```bash
curl -s http://127.0.0.1:8787/api/report/branches \
  -H 'Cookie: __Secure-better-auth.session_token=<owner-session>'
```

Expected: `200` with `"source":"clickhouse"` and a non-empty `branches` array.

### Task 2: Add a mount-type regression guard

**Files:**
- Create: `deploy/analytics/check-reader-mount.sh`
- Test: `deploy/analytics/check-reader-mount.test.sh`

**Interfaces:**
- `check_reader_mount <compose-file> <host-path>` exits 0 when the ClickHouse service maps `<host-path>` to a file, not a directory.
- The guard reads the compose YAML volume list for the `clickhouse` service only.

- [ ] **Step 1: Write the failing test**

```bash
test_file_mount_passes
test_directory_mount_refuses
test_missing_mount_refuses
```

- [ ] **Step 2: Run the tests and confirm failure**

```bash
bash deploy/analytics/check-reader-mount.test.sh
```

Expected: FAIL with missing guard.

- [ ] **Step 3: Implement the guard**

The function must:

1. Inspect `deploy/analytics/compose.yaml` for the `clickhouse` service volumes.
2. Find the entry ending in `/clickhouse-reader.xml:/etc/clickhouse-server/users.d/reader.xml:ro`.
3. Stat the host path `/opt/analytics/clickhouse-reader.xml` on the VM and require it to be a regular file.
4. Exit 1 with `Refusing: reader.xml is not a regular file` otherwise.

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
bash deploy/analytics/check-reader-mount.test.sh
```

Expected: all tests PASS.

- [ ] **Step 5: Run the guard on the live VM**

```bash
bash deploy/analytics/check-reader-mount.sh /opt/analytics/compose.yaml /opt/analytics/clickhouse-reader.xml
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add deploy/analytics/check-reader-mount.sh deploy/analytics/check-reader-mount.test.sh
git commit -m "feat(ops): guard against directory mount hiding reader.xml"
```

### Task 3: Update the handoff record

**Files:**
- Modify: `docs/04_traceability/ops-verification-2026-11-07-narrow-grant-production.md`
- Modify: `docs/07_handoffs/2026-09-30-handoff-priorities.md`

**Interfaces:**
- Production status may change only after Task 1 Step 7 returns `source: clickhouse`.

- [ ] **Step 1: Write the incident record**

Include backup marker, mount fix, `system.users` before/after, branches API status, and dashboard status.

- [ ] **Step 2: Update the performance checklist**

Mark the reader restoration as done in the handoff.

- [ ] **Step 3: Commit**

```bash
git add docs/04_traceability/ops-verification-2026-11-07-narrow-grant-production.md \
  docs/07_handoffs/2026-09-30-handoff-priorities.md
git commit -m "docs(ops): record ClickHouse reader restoration"
```
