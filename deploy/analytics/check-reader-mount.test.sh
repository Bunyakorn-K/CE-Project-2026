#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
COMPOSE_FILE="$TMP_ROOT/compose.yaml"
HOST_PATH="$TMP_ROOT/clickhouse-reader.xml"

if [[ ! -f "$SCRIPT_DIR/check-reader-mount.sh" ]]; then
  printf 'FAIL: missing guard\n'
  exit 1
fi

# shellcheck disable=SC1091
source "$SCRIPT_DIR/check-reader-mount.sh"

pass_count=0
fail_count=0

track() {
  local name="$1" expected="$2"
  shift 2
  set +e
  "$@" >/dev/null 2>&1
  local rc=$?
  set -e
  if [[ "$rc" -eq "$expected" ]]; then
    printf 'PASS: %s\n' "$name"
    pass_count=$((pass_count + 1))
  else
    printf 'FAIL: %s (got %s, expected %s)\n' "$name" "$rc" "$expected"
    fail_count=$((fail_count + 1))
  fi
}

write_compose() {
  cat > "$COMPOSE_FILE" <<'YAML'
services:
  clickhouse:
    volumes:
      - ./clickhouse-reader.xml:/etc/clickhouse-server/users.d/reader.xml:ro
YAML
}

test_file_mount_passes() {
  write_compose
  printf '<clickhouse><users><reader/></users></clickhouse>' > "$HOST_PATH"
  check_reader_mount "$COMPOSE_FILE" "$HOST_PATH"
}

test_directory_mount_refuses() {
  write_compose
  rm -f "$HOST_PATH"
  mkdir -p "$HOST_PATH"
  check_reader_mount "$COMPOSE_FILE" "$HOST_PATH"
}

test_missing_file_refuses() {
  write_compose
  rm -rf "$HOST_PATH"
  check_reader_mount "$COMPOSE_FILE" "$HOST_PATH"
}

track test_file_mount_passes 0 test_file_mount_passes
track test_directory_mount_refuses 1 test_directory_mount_refuses
track test_missing_file_refuses 1 test_missing_file_refuses

printf 'check-reader-mount: %s passed, %s failed\n' "$pass_count" "$fail_count"
[[ "$fail_count" -eq 0 ]]
