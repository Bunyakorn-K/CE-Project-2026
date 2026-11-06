#!/usr/bin/env bash
# restore-guards unit tests — local harness, no Python test runner.
#
# Follows the find_missing_days pattern from
# docs/04_traceability/ops-verification-2026-09-30-warehouse-data-recovery.md
# §1.6: plain bash assertions against fixture dirs with controlled mtimes and
# a mocked ClickHouse HTTP endpoint. Each test verifies the guard fails for
# the right reason (and would fail against deliberately broken code).
#
# Run: bash deploy/analytics/restore-guards.test.sh
# Exit 0 = all pass. Exit 1 = at least one failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/restore-guards.sh"

PASS=0
FAIL=0
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# --- helpers ---------------------------------------------------------------

# Make a fake backup tarball whose newest member has the given epoch.
_make_backup() {
    local name="$1" epoch="$2"
    local dir="$TMP_ROOT/$name-src"
    mkdir -p "$dir"
    printf 'fixture' > "$dir/payload.txt"
    touch -d "@$epoch" "$dir/payload.txt" 2>/dev/null \
        || touch -t "$(date -r "$epoch" +%Y%m%d%H%M.%S 2>/dev/null || echo 202608310432)" "$dir/payload.txt"
    tar -czf "$TMP_ROOT/$name.tgz" -C "$dir" payload.txt
    echo "$TMP_ROOT/$name.tgz"
}

# Make a fake live-volume dir with a file at the given epoch.
_make_live() {
    local name="$1" epoch="$2"
    local dir="$TMP_ROOT/$name-live"
    mkdir -p "$dir/part1"
    printf 'live' > "$dir/part1/data.bin"
    touch -d "@$epoch" "$dir/part1/data.bin" 2>/dev/null \
        || touch -t "$(date -r "$epoch" +%Y%m%d%H%M.%S 2>/dev/null || echo 202609171032)" "$dir/part1/data.bin"
    echo "$dir"
}

# Start a tiny mock ClickHouse HTTP server (python3 stdlib only), once.
# Serves the response in $MOCK_BODY for EVERY request (no 1-shot exit,
# which is what hung the test: the socket closed before curl hit it).
# Usage: _start_mock_clickhouse  -> sets $MOCK_PORT
_start_mock_clickhouse() {
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
    for _ in $(seq 1 50); do
        [[ -f "$port_file" ]] && break
        sleep 0.1
    done
    MOCK_PORT="$(cat "$port_file")"
}

_stop_mock_clickhouse() {
    pkill -f "PORT_FILE=$TMP_ROOT/mock-port.txt" 2>/dev/null || true
}

assert_pass() {
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then
        echo "PASS: $desc"; PASS=$((PASS+1))
    else
        echo "FAIL: $desc (expected pass, got fail)"; FAIL=$((FAIL+1))
    fi
}

assert_fail() {
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then
        echo "FAIL: $desc (expected fail, got pass)"; FAIL=$((FAIL+1))
    else
        echo "PASS: $desc (correctly refused)"; PASS=$((PASS+1))
    fi
}

# --- tests: assert_restore_source_fresh ------------------------------------

# 2026-09-17 shape: backup 17 days older than live -> MUST refuse
OLD_BACKUP="$(_make_backup old-backup 1785457920)"   # 2026-08-31 04:32 UTC
LIVE_NEW="$(_make_live live-new 1789278720)"         # 2026-09-17 10:32 UTC
assert_fail "source-freshness: 17-day-old backup vs fresh live -> refuses" \
    assert_restore_source_fresh "$OLD_BACKUP" "$LIVE_NEW"

# Fresh backup newer than live -> MUST pass
FRESH_BACKUP="$(_make_backup fresh-backup 1789368000)"  # 2026-09-18
assert_pass "source-freshness: fresh backup vs older live -> passes" \
    assert_restore_source_fresh "$FRESH_BACKUP" "$LIVE_NEW"

# Equal timestamps -> passes (backup >= live)
EQUAL_BACKUP="$(_make_backup equal-backup 1789278720)"
assert_pass "source-freshness: equal timestamps -> passes" \
    assert_restore_source_fresh "$EQUAL_BACKUP" "$LIVE_NEW"

# Missing backup file -> must fail (not pass silently)
assert_fail "source-freshness: missing backup file -> refuses" \
    assert_restore_source_fresh "$TMP_ROOT/does-not-exist.tgz" "$LIVE_NEW"

# Missing live dir -> must fail
assert_fail "source-freshness: missing live dir -> refuses" \
    assert_restore_source_fresh "$FRESH_BACKUP" "$TMP_ROOT/no-such-dir"

# --- tests: assert_post_restore_continuity ---------------------------------
# One server, body swapped per test (the server reads $MOCK_BODY at
# startup, so restart it between cases).

run_continuity() {
    # run_continuity <body> <pre-boundary> <expected: pass|fail> <desc>
    local body="$1" pre="$2" expected="$3" desc="$4"
    MOCK_BODY="$body" _start_mock_clickhouse
    if [[ "$expected" == "pass" ]]; then
        assert_pass "$desc" \
            assert_post_restore_continuity "http://127.0.0.1:$MOCK_PORT" "$pre"
    else
        assert_fail "$desc" \
            assert_post_restore_continuity "http://127.0.0.1:$MOCK_PORT" "$pre"
    fi
    _stop_mock_clickhouse
    rm -f "$TMP_ROOT/mock-port.txt"
}

run_continuity "2026-08-31 04:32:00" "2026-09-17 10:32:00" fail \
    "continuity: restored 2026-08-31 vs pre 2026-09-17 -> refuses"

run_continuity "2026-09-18 10:00:00" "2026-09-17 10:32:00" pass \
    "continuity: restored 2026-09-18 vs pre 2026-09-17 -> passes"

run_continuity "2026-09-17 10:32:00" "2026-09-17 10:32:00" pass \
    "continuity: restored == pre-restore -> passes"

run_continuity "" "2026-09-17 10:32:00" fail \
    "continuity: empty max(extracted_at) -> refuses"

# --- summary ---------------------------------------------------------------

echo ""
echo "restore-guards: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
