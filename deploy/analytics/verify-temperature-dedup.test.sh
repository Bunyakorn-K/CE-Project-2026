#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The production script does not exist yet in RED. Capture that state rather
# than sourcing a stale prerequisite.

pass_count=0
fail_count=0

track() {
  local name="$1"
  local status=$2
  if [[ "$status" -eq 0 ]]; then
    printf 'PASS: %s\n' "$name"
    pass_count=$((pass_count + 1))
  else
    printf 'FAIL: %s\n' "$name"
    fail_count=$((fail_count + 1))
  fi
}

if [[ ! -f "$SCRIPT_DIR/verify-temperature-dedup.sh" ]]; then
  printf 'FAIL: missing verifier functions\n'
  exit 1
fi

# shellcheck disable=SC1091
source "$SCRIPT_DIR/verify-temperature-dedup.sh"

with_responses() {
  local live="$1"
  local rollback="$2"
  local fresh="$3"
  local now="$4"
  local absent="$5"
  MOCK_LIVE_ROWS="$live"
  MOCK_ROLLBACK_ROWS="$rollback"
  MOCK_FRESH_LAG_MINUTES="$fresh"
  MOCK_NOW="$now"
  MOCK_ABSENT_TABLE_COUNT="$absent"
}

test_count_mismatch_refuses() {
  with_responses 2258218 3762139 0 "2026-11-07 00:00:00" 1
  assert_temperature_dedup_counts >/dev/null 2>&1
}

test_rollback_missing_refuses() {
  with_responses 2258219 0 0 "2026-11-07 00:00:00" 0
  assert_temperature_dedup_counts >/dev/null 2>&1
}

test_stale_live_table_refuses() {
  with_responses 2258219 3762139 31 "2026-11-07 00:00:00" 1
  assert_temperature_dedup_freshness >/dev/null 2>&1
}

test_correct_counts_pass() {
  with_responses 2642914 3762139 30 "2026-11-07 00:00:00" 1
  assert_temperature_dedup_counts &&
  assert_temperature_dedup_freshness
}

test_drop_absence_marker_passes() {
  with_responses 2258219 3762139 0 "2026-11-07 00:00:00" 0
  assert_rollback_table_dropped
}

for name in test_count_mismatch_refuses test_rollback_missing_refuses test_stale_live_table_refuses test_correct_counts_pass test_drop_absence_marker_passes; do
  set +e
  "$name"
  rc=$?
  set -e
  expected_status=0
  case "$name" in
    test_count_mismatch_refuses|test_rollback_missing_refuses|test_stale_live_table_refuses) expected_status=1 ;;
  esac
  if [[ "$rc" -eq "$expected_status" ]]; then
    track "$name" 0
  else
    track "$name" 1
  fi
done

printf 'verify-temperature-dedup: %s passed, %s failed\n' "$pass_count" "$fail_count"
[[ "$fail_count" -eq 0 ]]
