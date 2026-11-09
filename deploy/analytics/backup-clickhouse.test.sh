#!/usr/bin/env bash
# backup-clickhouse unit tests — local harness, mock ClickHouse over HTTP.
#
# The mock routes on the query it receives (BACKUP vs the system.backups
# verification) and can capture the exact SQL, which is how the disk-name defect
# is tested: the helper used Disk('backup') while the server declares `backups`,
# so every real call failed at "Disk 'backup' not found".
#
# Run: bash deploy/analytics/backup-clickhouse.test.sh
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

PASS=0
FAIL=0

run_test() {
  local name="$1" expected="$2"
  local got=0
  set +e
  "$name"
  got=$?
  set -e
  if [[ "$got" -eq "$expected" ]]; then
    printf 'PASS: %s\n' "$name"
    PASS=$((PASS + 1))
    return 0
  fi
  printf 'FAIL: %s (got %s, expected %s)\n' "$name" "$got" "$expected"
  FAIL=$((FAIL + 1))
  return 1
}

# Start a mock ClickHouse HTTP server (python3 stdlib) that routes on the query:
# a BACKUP call gets MOCK_BACKUP_BODY, everything else gets MOCK_STATUS_BODY.
_start_mock() {
  local port_file="$TMP_ROOT/mock-port-$RANDOM-$RANDOM.txt"
  PORT_FILE="$port_file" \
  MOCK_BACKUP_BODY="${MOCK_BACKUP_BODY:-}" \
  MOCK_BACKUP_STATUS="${MOCK_BACKUP_STATUS:-200}" \
  MOCK_STATUS_BODY="${MOCK_STATUS_BODY:-BACKUP_CREATED	11	5000000}" \
  MOCK_CAPTURE="${MOCK_CAPTURE:-}" \
  python3 - <<'PYEOF' >/dev/null 2>&1 &
import os, http.server, socketserver
backup_body = os.environ["MOCK_BACKUP_BODY"].encode()
backup_status = int(os.environ["MOCK_BACKUP_STATUS"])
status_body = os.environ["MOCK_STATUS_BODY"].encode()
capture = os.environ.get("MOCK_CAPTURE") or ""
port_file = os.environ["PORT_FILE"]

class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length).decode()
        # The helper posts the SQL as the raw body (the credential travels in
        # curl's config channel), so the body IS the query.
        query = raw
        if capture and query:
            with open(capture, "a") as handle:
                handle.write(query.replace("\n", " ") + "\n")
        if query.strip().startswith("BACKUP"):
            body, code = backup_body, backup_status
        else:
            body, code = status_body, 200
        self.send_response(code)
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass

with socketserver.TCPServer(("127.0.0.1", 0), H) as httpd:
    open(port_file, "w").write(str(httpd.server_address[1]))
    httpd.serve_forever()
PYEOF
  MOCK_PID="$!"
  for _ in $(seq 1 50); do [[ -f "$port_file" ]] && break; sleep 0.1; done
  MOCK_PORT="$(cat "$port_file")"
  CLICKHOUSE_URL="http://127.0.0.1:$MOCK_PORT"
}

_stop_mock() {
  [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null || true
  wait "$MOCK_PID" 2>/dev/null || true
  MOCK_PID=""
  unset CLICKHOUSE_URL MOCK_CAPTURE
}

test_missing_backup_dir_is_created() {
  BACKUP_TARGET_DIR="$TMP_ROOT/nonexistent-dir"
  BACKUP_NAME="missing"
  _start_mock
  create_clickhouse_backup
  _stop_mock
}

test_non_ok_status_refuses() {
  BACKUP_TARGET_DIR="$TMP_ROOT/non-ok-dir"
  BACKUP_NAME="failed"
  MOCK_STATUS_BODY="BACKUP_FAILED	0	0" _start_mock
  ! create_clickhouse_backup 2>/dev/null
  _stop_mock
}

test_empty_backup_refuses() {
  # The 2026-11-07 backup on this host: status OK, 11 files, 3.85 KiB, of the
  # wrong database. It must not be written down as a success.
  BACKUP_TARGET_DIR="$TMP_ROOT/empty-dir"
  BACKUP_NAME="empty"
  MOCK_STATUS_BODY="OK	0	0" _start_mock
  ! create_clickhouse_backup 2>/dev/null
  [[ ! -f "$BACKUP_TARGET_DIR/$BACKUP_NAME.done" ]] || { _stop_mock; return 1; }
  _stop_mock
}

test_accepts_the_legacy_ok_status() {
  BACKUP_TARGET_DIR="$TMP_ROOT/legacy-dir"
  BACKUP_NAME="legacy"
  MOCK_STATUS_BODY="OK	11	5000000" _start_mock
  create_clickhouse_backup >/dev/null
  [[ -f "$BACKUP_TARGET_DIR/$BACKUP_NAME.done" ]] || { _stop_mock; return 1; }
  _stop_mock
}

test_tiny_backup_refuses() {
  BACKUP_TARGET_DIR="$TMP_ROOT/tiny-dir"
  BACKUP_NAME="tiny"
  MOCK_STATUS_BODY="OK	11	512" _start_mock
  ! create_clickhouse_backup 2>/dev/null
  _stop_mock
}

test_successful_backup_writes_marker() {
  BACKUP_TARGET_DIR="$TMP_ROOT/new-dir"
  BACKUP_NAME="success"
  _start_mock
  create_clickhouse_backup
  [[ -f "$BACKUP_TARGET_DIR/$BACKUP_NAME.done" ]] || { _stop_mock; return 1; }
  _stop_mock
}

test_failed_backup_writes_no_marker() {
  BACKUP_TARGET_DIR="$TMP_ROOT/failure-dir"
  BACKUP_NAME="failure"
  MOCK_BACKUP_STATUS=500 MOCK_BACKUP_BODY="Code: 60. DB::Exception: Disk 'backups' not found" _start_mock
  ! create_clickhouse_backup 2>/dev/null
  [[ ! -f "$BACKUP_TARGET_DIR/$BACKUP_NAME.done" ]] || { _stop_mock; return 1; }
  _stop_mock
}

test_backup_targets_the_configured_disk() {
  BACKUP_TARGET_DIR="$TMP_ROOT/disk-dir"
  BACKUP_NAME="disk"
  MOCK_CAPTURE="$TMP_ROOT/captured-sql.txt" _start_mock
  create_clickhouse_backup >/dev/null
  _stop_mock
  # The disk the server declares, not the one the old helper invented.
  grep -q "Disk('backups', 'disk')" "$TMP_ROOT/captured-sql.txt"
}

test_free_space_guard_refuses() {
  BACKUP_TARGET_DIR="$TMP_ROOT/space-dir"
  BACKUP_NAME="space"
  _start_mock
  local previous="$MIN_FREE_MB"
  MIN_FREE_MB=999999999
  ! create_clickhouse_backup 2>/dev/null
  MIN_FREE_MB="$previous"
  _stop_mock
}

test_prune_keeps_newest_and_only_its_prefix() {
  local dir="$TMP_ROOT/prune-dir"
  mkdir -p "$dir"
  local stamp
  for stamp in 1 2 3 4 5; do
    mkdir -p "$dir/laundrytwin-2026110${stamp}T000000Z"
    touch -t "2026110${stamp}0000" "$dir/laundrytwin-2026110${stamp}T000000Z"
  done
  mkdir -p "$dir/pre-hand-made"
  touch -t 202601010000 "$dir/pre-hand-made"
  prune_old_backups "$dir" 2 "laundrytwin-"
  local kept
  kept="$(find "$dir" -mindepth 1 -maxdepth 1 -name 'laundrytwin-*' | wc -l | tr -d ' ')"
  [[ "$kept" == "2" ]] || { printf 'kept %s backups, expected 2\n' "$kept" >&2; return 1; }
  [[ -d "$dir/pre-hand-made" ]] || { printf 'pruned a hand-made backup\n' >&2; return 1; }
}

run_test test_missing_backup_dir_is_created 0
run_test test_non_ok_status_refuses 0
run_test test_empty_backup_refuses 0
run_test test_accepts_the_legacy_ok_status 0
run_test test_tiny_backup_refuses 0
run_test test_successful_backup_writes_marker 0
run_test test_failed_backup_writes_no_marker 0
run_test test_backup_targets_the_configured_disk 0
run_test test_free_space_guard_refuses 0
test_verification_matches_the_disk_qualified_name() {
  # system.backups.name is `Disk('backups', 'name')`, so an equality check on the
  # bare name finds nothing and reports an empty status.
  BACKUP_TARGET_DIR="$TMP_ROOT/verify-dir"
  BACKUP_NAME="verify"
  MOCK_CAPTURE="$TMP_ROOT/verify-sql.txt" _start_mock
  create_clickhouse_backup >/dev/null
  _stop_mock
  grep -q "position(name, 'verify')" "$TMP_ROOT/verify-sql.txt" || { printf 'verification query does not match the row\n' >&2; return 1; }
  ! grep -q "WHERE name = " "$TMP_ROOT/verify-sql.txt" || { printf 'verification still compares name for equality\n' >&2; return 1; }
}

test_rejects_an_unsafe_backup_name() {
  BACKUP_TARGET_DIR="$TMP_ROOT/unsafe-dir"
  BACKUP_NAME="bad'name"
  _start_mock
  ! create_clickhouse_backup 2>/dev/null
  _stop_mock
}

run_test test_prune_keeps_newest_and_only_its_prefix 0
run_test test_verification_matches_the_disk_qualified_name 0
run_test test_rejects_an_unsafe_backup_name 0

printf 'backup-clickhouse: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
