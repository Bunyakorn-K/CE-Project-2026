#!/usr/bin/env bash
set -euo pipefail

EXPECTED_LIVE_ROWS=2258219
EXPECTED_ROLLBACK_ROWS=3762139
FRESHNESS_LIMIT_MINUTES=30

_clickhouse_query() {
  local sql="$1"
  if [[ -n "${MOCK_LIVE_ROWS:-}" ]]; then
    case "$sql" in
      *"FROM fact_temperature_sample FINAL"*) printf '%s\n' "$MOCK_LIVE_ROWS" ;;
      *"FROM fact_temperature_sample_pre_dedup"*) printf '%s\n' "$MOCK_ROLLBACK_ROWS" ;;
      *"dateDiff('minute', max(extracted_at), now()) FROM fact_temperature_sample"*) printf '%s\n' "$MOCK_FRESH_LAG_MINUTES" ;;
      *"name = 'fact_temperature_sample_pre_dedup'"*) printf '%s\n' "$MOCK_ABSENT_TABLE_COUNT" ;;
      *) return 1 ;;
    esac
    return 0
  fi
  local url="${CLICKHOUSE_URL:-http://127.0.0.1:8123}"
  local user="${CLICKHOUSE_USER:-default}"
  local password="${CLICKHOUSE_PASSWORD:-}"
  local database="${CLICKHOUSE_DATABASE:-laundrytwin_analytics}"
  curl -sS --fail --max-time 30 \
    --data-urlencode "query=$sql" \
    --data-urlencode "user=$user" \
    --data-urlencode "password=$password" \
    --data-urlencode "database=$database" \
    "$url/"
}

temperature_dedup_counts() {
  local live rollback
  live="$(_clickhouse_query "SELECT count() AS live_rows FROM fact_temperature_sample FINAL")"
  rollback="$(_clickhouse_query "SELECT count() AS rollback_rows FROM fact_temperature_sample_pre_dedup")"
  printf 'live_rows=%s rollback_rows=%s\n' "$live" "$rollback"
}

assert_temperature_dedup_counts() {
  local live rollback
  live="$(_clickhouse_query "SELECT count() AS live_rows FROM fact_temperature_sample FINAL")"
  rollback="$(_clickhouse_query "SELECT count() AS rollback_rows FROM fact_temperature_sample_pre_dedup")"
  if [[ "$live" != "$EXPECTED_LIVE_ROWS" || "$rollback" != "$EXPECTED_ROLLBACK_ROWS" ]]; then
    printf 'Refusing: expected live_rows=%s rollback_rows=%s, got live_rows=%s rollback_rows=%s\n' \
      "$EXPECTED_LIVE_ROWS" "$EXPECTED_ROLLBACK_ROWS" "$live" "$rollback" >&2
    return 1
  fi
  printf 'temperature dedup counts OK: live_rows=%s rollback_rows=%s\n' "$live" "$rollback"
}

assert_temperature_dedup_freshness() {
  local lag
  lag="$(_clickhouse_query "SELECT dateDiff('minute', max(extracted_at), now()) FROM fact_temperature_sample")"
  if [[ ! "$lag" =~ ^[0-9]+$ ]] || (( lag > FRESHNESS_LIMIT_MINUTES )); then
    printf 'Refusing: temperature freshness lag is %s minutes, limit is %s\n' "$lag" "$FRESHNESS_LIMIT_MINUTES" >&2
    return 1
  fi
  printf 'temperature freshness OK: %s minutes lag\n' "$lag"
}

assert_rollback_table_dropped() {
  local count
  count="$(_clickhouse_query "SELECT count() FROM system.tables WHERE database = currentDatabase() AND name = 'fact_temperature_sample_pre_dedup'")"
  if [[ "$count" != "0" ]]; then
    printf 'Refusing: fact_temperature_sample_pre_dedup still exists\n' >&2
    return 1
  fi
  printf 'rollback table absent: fact_temperature_sample_pre_dedup\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    counts) temperature_dedup_counts ;;
    assert_counts) assert_temperature_dedup_counts ;;
    assert_freshness) assert_temperature_dedup_freshness ;;
    assert_dropped) assert_rollback_table_dropped ;;
    *) printf 'Usage: %s [counts|assert_counts|assert_freshness|assert_dropped]\n' "$0" >&2; exit 2 ;;
  esac
fi
