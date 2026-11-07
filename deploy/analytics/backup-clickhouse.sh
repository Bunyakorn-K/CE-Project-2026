#!/usr/bin/env bash
set -euo pipefail

_clickhouse_query() {
  local sql="$1"
  # No test-only affordance in production code; no eval, no env-controlled
  # execution. Tests use a real HTTP endpoint, same as production.
  :
  local url="${CLICKHOUSE_URL:-http://127.0.0.1:8123}"
  local user="${CLICKHOUSE_USER:-default}"
  local password="${CLICKHOUSE_PASSWORD:-}"
  curl -sS --fail --max-time 300 \
    --data-urlencode "query=$sql" \
    --data-urlencode "user=$user" \
    --data-urlencode "password=$password" \
    --data-urlencode "database=$CLICKHOUSE_DATABASE" \
    "$url/"
}

create_clickhouse_backup() {
  : "${BACKUP_TARGET_DIR:?BACKUP_TARGET_DIR is required}"
  : "${BACKUP_NAME:?BACKUP_NAME is required}"
  : "${CLICKHOUSE_DATABASE:?CLICKHOUSE_DATABASE is required}"

  mkdir -p "$BACKUP_TARGET_DIR"

  local backup_sql="BACKUP DATABASE $CLICKHOUSE_DATABASE TO Disk('backup', '$BACKUP_NAME')"
  local status

  # Step 1: run BACKUP and capture the response (ClickHouse can return
  # 200 with an error body, so --fail alone is not sufficient).
  local backup_response
  backup_response="$(_clickhouse_query "$backup_sql")" || {
    printf 'Refusing: BACKUP DATABASE failed\n' >&2
    return 1
  }

  # Step 2: verify via system.backups that the backup actually completed.
  status="$(_clickhouse_query "SELECT status FROM system.backups WHERE name = '$BACKUP_NAME' ORDER BY start_time DESC LIMIT 1")" || {
    printf 'Refusing: cannot verify backup status\n' >&2
    return 1
  }

  if [[ "$status" != "OK" ]]; then
    printf 'Refusing: ClickHouse backup status is %s, not OK\n' "$status" >&2
    return 1
  fi

  : > "$BACKUP_TARGET_DIR/$BACKUP_NAME.done"
  printf 'ClickHouse backup OK: %s/%s.done\n' "$BACKUP_TARGET_DIR" "$BACKUP_NAME"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  create_clickhouse_backup
fi
