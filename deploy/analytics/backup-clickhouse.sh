#!/usr/bin/env bash
# LaundryTwin warehouse backup — one run, verified, pruned.
#
# WHY THIS EXISTS. The repository said for months that "this warehouse has no
# automated backup". deploy/ in this directory already had a backup helper and a
# test for it, but nothing ever called it: there is no `cron` binary on the VM
# and no systemd timer, so every backup in the record was taken by hand before a
# specific change. That is the gap a deploy gate cannot work around.
#
# THE THREE THINGS THIS NOW REFUSES, each measured on this host on 2026-11-09:
#
#   1. A WRONG DISK NAME. The helper used `Disk('backup', …)` while
#      clickhouse-backup-disk.xml declares the disk as `backups`. Every call
#      would have failed with "Disk 'backup' not found" — the reason nothing was
#      ever scheduled with it.
#   2. A BACKUP OF THE WRONG (EMPTY) DATABASE. The one "successful" backup on
#      the host, `pre-closed-rendering-test` (2026-11-07), holds **11 files and
#      3.85 KiB**: it backed up the `default` database, because
#      CLICKHOUSE_DATABASE was unset in that shell. It reported status OK. A
#      backup that is three orders of magnitude too small is a failed backup,
#      exactly as a 4 KB SQLite `cp` is, so the size is now asserted.
#   3. FILLING THE DISK. `/` had 7.9 GB free against a 16 GB ClickHouse volume;
#      a `KEEP_BACKUPS` policy that outgrows the filesystem takes the warehouse
#      down with it. Free space is checked before the backup runs and only names
#      matching $BACKUP_PREFIX are ever pruned, so a hand-made `pre-*` backup is
#      never deleted by the timer.
#
# The real database measures 114.71 MiB on disk (2026-11-09), so a full daily
# backup is ~1 % of the free space; the guards exist for the day that stops being
# true.
#
# Usage (the systemd unit in deploy/analytics sets these):
#   CLICKHOUSE_DATABASE=laundrytwin_analytics \
#   BACKUP_TARGET_DIR=/data/backups/clickhouse \
#   BACKUP_NAME=laundrytwin-$(date -u +%Y%m%dT%H%M%SZ) \
#   bash backup-clickhouse.sh
set -euo pipefail

BACKUP_DISK="${BACKUP_DISK:-backups}"
BACKUP_PREFIX="${BACKUP_PREFIX:-laundrytwin-}"
KEEP_BACKUPS="${KEEP_BACKUPS:-7}"
MIN_FREE_MB="${MIN_FREE_MB:-1024}"
# 2026-11-09: the smallest honest backup of this database is ~115 MiB. Anything
# under a megabyte is an empty database wearing a successful status.
MIN_BACKUP_BYTES="${MIN_BACKUP_BYTES:-1000000}"

# POST the SQL as the request body, with the credential supplied by curl's own
# config channel so it never appears in `ps`.
#
# Two measured facts shaped this (2026-11-09): ClickHouse does NOT read `user`
# from form fields in the body — the 401 it answered said `default: Authentication
# failed` while the script was sending user=admin — and `-u admin:password` on argv
# is visible to every local user through /proc. So the credential goes through
# `--config <(...)` (a file descriptor, not an argument) as HTTP Basic, the
# database goes in the URL, and the body is the query alone.
_clickhouse_query() {
  local sql="$1"
  local url="${CLICKHOUSE_URL:-http://127.0.0.1:8123}"
  local user="${CLICKHOUSE_USER:-default}"
  local password="${CLICKHOUSE_PASSWORD:-}"
  local target="${url%/}/"
  if [[ -n "${CLICKHOUSE_DATABASE:-}" ]]; then
    target="${target}?database=${CLICKHOUSE_DATABASE}"
  fi
  local escaped="${password//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  curl -sS --fail --max-time 300 \
    --config <(printf 'user = "%s:%s"\n' "$user" "$escaped") \
    --data-binary "$sql" \
    "$target"
}

# Keep only the newest $KEEP_BACKUPS entries whose name starts with
# $BACKUP_PREFIX. Anything else in the directory is left alone: operations staff
# take `pre-<change>` backups by hand and the timer must not eat them.
prune_old_backups() {
  local dir="$1" keep="$2" prefix="$3"
  [[ -d "$dir" ]] || return 0
  # `ls -1dt` rather than `find -printf`: -printf is GNU-only, and this script
  # has to run under the macOS bash 3.2 the test harness uses as well as the
  # Debian bash 5 on the VM.
  local -a entries=()
  local entry
  while IFS= read -r entry; do
    if [[ -e "$entry" ]]; then
      entries+=("$entry")
    fi
  done < <(ls -1dt "$dir"/"${prefix}"* 2>/dev/null)

  # `${entries[@]+…}` rather than `"${entries[@]}"`: an empty array expansion is
  # an unbound variable under `set -u` in bash 3.2, which is what macOS ships —
  # and this file has to be runnable from the developer machine's test harness.
  local index=0
  for path in ${entries[@]+"${entries[@]}"}; do
    index=$((index + 1))
    if (( index > keep )); then
      printf 'pruning %s (keep %s)\n' "$path" "$keep"
      rm -rf -- "$path"
      rm -f -- "$path.done"
    fi
  done
}

# Refuse before writing, not after: a full filesystem during a backup leaves a
# half-written backup that looks like a backup.
assert_free_space() {
  local dir="$1" minimum_mb="$2"
  local free_mb
  free_mb="$(df -Pm "$dir" | awk 'NR==2 {print $4}')"
  if [[ -z "$free_mb" ]]; then
    printf 'Refusing: cannot read free space for %s\n' "$dir" >&2
    return 1
  fi
  if (( free_mb < minimum_mb )); then
    printf 'Refusing: %s has %s MB free, need at least %s MB\n' "$dir" "$free_mb" "$minimum_mb" >&2
    return 1
  fi
}

create_clickhouse_backup() {
  : "${BACKUP_TARGET_DIR:?BACKUP_TARGET_DIR is required}"
  : "${BACKUP_NAME:?BACKUP_NAME is required}"
  : "${CLICKHOUSE_DATABASE:?CLICKHOUSE_DATABASE is required}"

  # The name is interpolated into SQL below, so it is restricted to a character
  # set this script itself generates.
  case "$BACKUP_NAME" in
    *[!A-Za-z0-9._-]*)
      printf 'Refusing: BACKUP_NAME may contain only letters, digits, dot, underscore and hyphen\n' >&2
      return 1
      ;;
  esac

  mkdir -p "$BACKUP_TARGET_DIR"
  assert_free_space "$BACKUP_TARGET_DIR" "$MIN_FREE_MB"

  local backup_sql="BACKUP DATABASE $CLICKHOUSE_DATABASE TO Disk('$BACKUP_DISK', '$BACKUP_NAME')"

  # Step 1: run BACKUP and capture the response (ClickHouse can return
  # 200 with an error body, so --fail alone is not sufficient).
  local backup_response
  backup_response="$(_clickhouse_query "$backup_sql")" || {
    printf 'Refusing: BACKUP DATABASE failed\n' >&2
    return 1
  }

  # Step 2: verify via system.backups that the backup completed AND that it has
  # content. A status of OK on an empty database is the failure this host
  # actually produced once, so the file count and the size are asserted, not the
  # status alone.
  local verification
  # system.backups.name is the whole BACKUP statement target — `Disk('backups',
  # 'laundrytwin-…')` — not the bare name, so an equality check on the name
  # matches nothing and reads as "<empty>, not OK". That is what the first real
  # run of this script did on 2026-11-09. `position()` on the generated,
  # character-restricted name is the match that actually finds the row.
  verification="$(_clickhouse_query "SELECT status, num_files, total_size FROM system.backups WHERE position(name, '$BACKUP_NAME') > 0 ORDER BY start_time DESC LIMIT 1 FORMAT TSV")" || {
    printf 'Refusing: cannot verify backup status\n' >&2
    return 1
  }

  local status num_files total_size
  IFS=$'\t' read -r status num_files total_size <<<"$verification"

  # The status this server reports on success is BACKUP_CREATED (measured on
  # 26.3.26.3, 2026-11-09); older builds answer OK. A helper that only accepted
  # "OK" refused every successful backup, which is how this one behaved until its
  # first real run.
  if [[ "$status" != "BACKUP_CREATED" && "$status" != "OK" ]]; then
    printf 'Refusing: ClickHouse backup status is %s, not BACKUP_CREATED/OK\n' "${status:-<empty>}" >&2
    return 1
  fi
  if [[ -z "${num_files:-}" || "$num_files" -le 0 ]]; then
    printf 'Refusing: backup %s reports %s files — that is an empty database, not a backup\n' \
      "$BACKUP_NAME" "${num_files:-0}" >&2
    return 1
  fi
  if [[ -z "${total_size:-}" || "$total_size" -lt "$MIN_BACKUP_BYTES" ]]; then
    printf 'Refusing: backup %s is %s bytes, below the %s byte floor — check CLICKHOUSE_DATABASE (%s)\n' \
      "$BACKUP_NAME" "${total_size:-0}" "$MIN_BACKUP_BYTES" "$CLICKHOUSE_DATABASE" >&2
    return 1
  fi

  : > "$BACKUP_TARGET_DIR/$BACKUP_NAME.done"
  printf 'ClickHouse backup OK: %s/%s.done (%s files, %s bytes)\n' \
    "$BACKUP_TARGET_DIR" "$BACKUP_NAME" "$num_files" "$total_size"

  prune_old_backups "$BACKUP_TARGET_DIR" "$KEEP_BACKUPS" "$BACKUP_PREFIX"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  create_clickhouse_backup
fi
