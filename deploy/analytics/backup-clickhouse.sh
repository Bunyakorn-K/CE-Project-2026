#!/usr/bin/env bash
set -euo pipefail

create_clickhouse_backup() {
  : "${BACKUP_TARGET_DIR:?BACKUP_TARGET_DIR is required}"
  : "${BACKUP_NAME:?BACKUP_NAME is required}"
  : "${CLICKHOUSE_DATABASE:?CLICKHOUSE_DATABASE is required}"

  mkdir -p "$BACKUP_TARGET_DIR"

  local backup_sql="BACKUP DATABASE $CLICKHOUSE_DATABASE TO Disk('backup', '$BACKUP_NAME')"
  local url="${CLICKHOUSE_URL:-http://127.0.0.1:8123}"
  local user="${CLICKHOUSE_USER:-default}"
  local password="${CLICKHOUSE_PASSWORD:-}"

  if [[ -n "${BACKUP_COMMAND:-}" ]]; then
    # Test-only affordance used by backup-clickhouse.test.sh.
    eval "$BACKUP_COMMAND" >/dev/null
  else
    curl -sS --fail --max-time 300 \
      --data-urlencode "query=$backup_sql" \
      --data-urlencode "user=$user" \
      --data-urlencode "password=$password" \
      --data-urlencode "database=$CLICKHOUSE_DATABASE" \
      "$url/" >/dev/null
  fi

  local status
  status="$(printf '%s' "${BACKUP_STATUS:-OK}")"
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
