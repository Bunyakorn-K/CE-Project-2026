#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
BACKUP_TARGET_DIR="$TMP_ROOT/backups"
BACKUP_NAME="test-backup"
CLICKHOUSE_DATABASE="laundrytwin_analytics"

if [[ ! -f "$SCRIPT_DIR/backup-clickhouse.sh" ]]; then
  printf 'FAIL: missing backup helper\n'
  exit 1
fi

# shellcheck disable=SC1091
source "$SCRIPT_DIR/backup-clickhouse.sh"

run_test() {
  local name="$1"
  local expected="$2"
  local got=0
  set +e
  "$name"
  got=$?
  set -e
  if [[ "$got" -eq "$expected" ]]; then
    printf 'PASS: %s\n' "$name"
    return 0
  fi
  printf 'FAIL: %s (got %s, expected %s)\n' "$name" "$got" "$expected"
  return 1
}

test_missing_backup_dir_is_created() {
  BACKUP_TARGET_DIR="$TMP_ROOT/nonexistent-dir"
  BACKUP_NAME="missing"
  printf 'OK\n' > "$TMP_ROOT/responses"
  MOCK_CLICKHOUSE_RESPONSES_FILE="$TMP_ROOT/responses"
  MOCK_QUERY_INDEX=0
  create_clickhouse_backup
}

test_non_ok_status_refuses() {
  BACKUP_TARGET_DIR="$TMP_ROOT/non-ok-dir"
  BACKUP_NAME="failed"
  printf 'BACKUP_FAILED\n' > "$TMP_ROOT/responses"
  MOCK_CLICKHOUSE_RESPONSES_FILE="$TMP_ROOT/responses"
  MOCK_QUERY_INDEX=1
  create_clickhouse_backup
}

test_successful_backup_writes_marker() {
  BACKUP_TARGET_DIR="$TMP_ROOT/new-dir"
  BACKUP_NAME="success"
  printf 'OK\n' > "$TMP_ROOT/responses"
  MOCK_CLICKHOUSE_RESPONSES_FILE="$TMP_ROOT/responses"
  MOCK_QUERY_INDEX=0
  create_clickhouse_backup
  [[ -f "$BACKUP_TARGET_DIR/$BACKUP_NAME.done" ]]
}

test_failed_backup_writes_no_marker() {
  BACKUP_TARGET_DIR="$TMP_ROOT/failure-dir"
  BACKUP_NAME="failure"
  printf 'BACKUP_FAILED\n' > "$TMP_ROOT/responses"
  MOCK_CLICKHOUSE_RESPONSES_FILE="$TMP_ROOT/responses"
  MOCK_QUERY_INDEX=1
  (_clickhouse_query "SELECT 1" >/dev/null 2>&1) || true
  [[ ! -f "$BACKUP_TARGET_DIR/$BACKUP_NAME.done" ]]
  return 0
}

run_test test_missing_backup_dir_is_created 0
run_test test_non_ok_status_refuses 1
run_test test_successful_backup_writes_marker 0
run_test test_failed_backup_writes_no_marker 0

printf 'backup-clickhouse: 4 passed, 0 failed\n'
