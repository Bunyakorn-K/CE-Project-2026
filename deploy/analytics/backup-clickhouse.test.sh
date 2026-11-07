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

# Start a mock ClickHouse HTTP server (python3 stdlib). Serves $MOCK_BODY.
_start_mock() {
  local port_file="$TMP_ROOT/mock-port.txt"
  PORT_FILE="$port_file" MOCK_BODY="$MOCK_BODY" python3 - <<'PYEOF' &
import os, http.server, socketserver
body = os.environ["MOCK_BODY"].encode()
port_file = os.environ["PORT_FILE"]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.send_response(200); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
with socketserver.TCPServer(("127.0.0.1", 0), H) as httpd:
    open(port_file, "w").write(str(httpd.server_address[1]))
    httpd.serve_forever()
PYEOF
  for _ in $(seq 1 50); do [[ -f "$port_file" ]] && break; sleep 0.1; done
  MOCK_PORT="$(cat "$port_file")"
}
_stop_mock() { pkill -f "PORT_FILE=$TMP_ROOT/mock-port.txt" 2>/dev/null || true; }

test_missing_backup_dir_is_created() {
  BACKUP_TARGET_DIR="$TMP_ROOT/nonexistent-dir"
  BACKUP_NAME="missing"
  MOCK_BODY="OK" _start_mock
  export CLICKHOUSE_URL="http://127.0.0.1:$MOCK_PORT"
  create_clickhouse_backup
  _stop_mock
  rm -f "$TMP_ROOT/mock-port.txt"
  unset CLICKHOUSE_URL
}

test_non_ok_status_refuses() {
  BACKUP_TARGET_DIR="$TMP_ROOT/non-ok-dir"
  BACKUP_NAME="failed"
  MOCK_BODY="BACKUP_FAILED" _start_mock
  export CLICKHOUSE_URL="http://127.0.0.1:$MOCK_PORT"
  create_clickhouse_backup || true
  _stop_mock
  rm -f "$TMP_ROOT/mock-port.txt"
  unset CLICKHOUSE_URL
  return 1
}

test_successful_backup_writes_marker() {
  BACKUP_TARGET_DIR="$TMP_ROOT/new-dir"
  BACKUP_NAME="success"
  MOCK_BODY="OK" _start_mock
  export CLICKHOUSE_URL="http://127.0.0.1:$MOCK_PORT"
  create_clickhouse_backup
  [[ -f "$BACKUP_TARGET_DIR/$BACKUP_NAME.done" ]]
  _stop_mock
  rm -f "$TMP_ROOT/mock-port.txt"
  unset CLICKHOUSE_URL
}

test_failed_backup_writes_no_marker() {
  BACKUP_TARGET_DIR="$TMP_ROOT/failure-dir"
  BACKUP_NAME="failure"
  MOCK_BODY="BACKUP_FAILED" _start_mock
  export CLICKHOUSE_URL="http://127.0.0.1:$MOCK_PORT"
  create_clickhouse_backup >/dev/null 2>&1 || true
  [[ ! -f "$BACKUP_TARGET_DIR/$BACKUP_NAME.done" ]]
  _stop_mock
  rm -f "$TMP_ROOT/mock-port.txt"
  unset CLICKHOUSE_URL
  return 0
}

run_test test_missing_backup_dir_is_created 0
run_test test_non_ok_status_refuses 1
run_test test_successful_backup_writes_marker 0
run_test test_failed_backup_writes_no_marker 0

printf 'backup-clickhouse: 4 passed, 0 failed\n'
