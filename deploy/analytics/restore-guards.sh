#!/usr/bin/env bash
# LaundryTwin warehouse restore guards.
#
# WHY THIS EXISTS. On 2026-09-17 the live ClickHouse volume was rolled back to
# a 17-day-old tarball after a correct, fresh backup was deleted 8 seconds
# earlier. Nothing refused it. The two guards below are the guards §1.5 of
# docs/04_traceability/ops-verification-2026-09-30-warehouse-data-recovery.md
# calls for:
#
#   1. assert_restore_source_fresh
#      A restore must refuse a source backup that is not newer than the
#      destination it would overwrite. The tarball's newest content was
#      17 days older than the live volume — a single `stat` would have
#      refused it.
#
#   2. assert_post_restore_continuity
#      Before any compose switch, max(extracted_at) in the restored warehouse
#      must be >= the pre-restore value. A warehouse that is silently behind
#      must not be started.
#
# BOTH ARE PURELY LOCAL. No production mutation. The caller (the restore
# procedure) invokes them and refuses to continue when they exit non-zero.
#
# The ClickHouse HTTP interface is used via curl (stdlib, no Python deps —
# this repo has no Python test runner, per §1.6 of the recovery record).
#
# Usage:
#   source deploy/analytics/restore-guards.sh
#   assert_restore_source_fresh <backup.tgz> <live-volume-dir>
#   assert_post_restore_continuity <clickhouse-url> <pre-boundary-timestamp>
#
# Timestamps: ISO 8601 UTC, e.g. 2026-09-17T10:32:00Z or 2026-09-17 10:32:00.
# Comparison is lexical on normalized strings (same format = lexicographic).

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Newest mtime (epoch seconds) under a directory tree, or of a single file.
# find + stat, POSIX only (no GNU find -printf).
_newest_epoch() {
    local target="$1"
    if [[ -f "$target" ]]; then
        stat -f '%m' "$target" 2>/dev/null || stat -c '%Y' "$target"
    else
        find "$target" -type f -exec stat -f '%m' {} \; 2>/dev/null \
            | sort -rn | head -n 1
        # GNU stat fallback if BSD stat gave nothing
        if [[ -z "$(find "$target" -type f -exec stat -f '%m' {} \; 2>/dev/null | head -n 1)" ]]; then
            find "$target" -type f -exec stat -c '%Y' {} \; 2>/dev/null | sort -rn | head -n 1
        fi
    fi
}

# Newest content timestamp inside a tar.gz backup, as epoch seconds.
# Reads the `tar tzf` member list and takes the latest member mtime — we
# cannot `stat` a file inside a tarball without extracting. GNU tar
# --list --verbose gives us the mtime; `--time` is not portable but BSD
# tar prints it in the same field. Fallback: extract to a temp dir and stat.
_tarball_newest_epoch() {
    local backup="$1"
    local tmpdir
    tmpdir="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap 'rm -rf "$tmpdir"' RETURN INT TERM

    tar -tzf "$backup" >/dev/null 2>&1 || {
        echo "restore-guards: cannot list $backup" >&2
        return 1
    }
    # Extract mtime-only to a scratch dir (fast: we discard contents)
    if ! tar -xzf "$backup" -C "$tmpdir" >/dev/null 2>&1; then
        echo "restore-guards: cannot extract $backup to scratch dir" >&2
        return 1
    fi
    find "$tmpdir" -type f -exec stat -f '%m' {} \; 2>/dev/null | sort -rn | head -n 1
    if [[ -z "$(find "$tmpdir" -type f -exec stat -f '%m' {} \; 2>/dev/null | head -n 1)" ]]; then
        find "$tmpdir" -type f -exec stat -c '%Y' {} \; 2>/dev/null | sort -rn | head -n 1
    fi
}

# ---------------------------------------------------------------------------
# Guard 1: restore-source freshness
# ---------------------------------------------------------------------------

# assert_restore_source_fresh <backup.tgz> <live-volume-dir>
#
# Refuses (exit 1) when the backup's newest content is OLDER than the live
# volume's newest file. Prints both epochs for the log.
# Exit 0 = source is at least as new as destination, safe to proceed.
assert_restore_source_fresh() {
    local backup="$1"
    local live_dir="$2"

    [[ -f "$backup" ]] || { echo "restore-guards: backup not found: $backup" >&2; return 1; }
    [[ -d "$live_dir" ]] || { echo "restore-guards: live volume dir not found: $live_dir" >&2; return 1; }

    local backup_epoch live_epoch
    backup_epoch="$(_tarball_newest_epoch "$backup")"
    live_epoch="$(_newest_epoch "$live_dir")"

    if [[ -z "$backup_epoch" || -z "$live_epoch" ]]; then
        echo "restore-guards: could not determine mtimes (backup='$backup_epoch' live='$live_epoch')" >&2
        return 1
    fi

    echo "restore-guards: backup newest epoch=$backup_epoch ($backup)"
    echo "restore-guards: live   newest epoch=$live_epoch ($live_dir)"

    if (( backup_epoch < live_epoch )); then
        echo "restore-guards: REFUSING restore — backup is $(( live_epoch - backup_epoch ))s older than live volume." >&2
        echo "restore-guards: this is the 2026-09-17 shape. Aborting." >&2
        return 1
    fi

    echo "restore-guards: source freshness OK (backup >= live)"
}

# ---------------------------------------------------------------------------
# Guard 2: post-restore continuity
# ---------------------------------------------------------------------------

# assert_post_restore_continuity <clickhouse-url> <pre-boundary>
#
# Queries max(extracted_at) from fact_machine_usage on the (restored)
# warehouse at <clickhouse-url> (e.g. http://127.0.0.1:8123). Refuses
# (exit 1) when the restored max is behind <pre-boundary> (the value
# recorded before the restore, same format).
# Exit 0 = restored warehouse is at least as fresh as before, safe to switch.
assert_post_restore_continuity() {
    local base_url="$1"
    local pre_boundary="$2"

    local body restored_max
    body="$(curl -sS --max-time 30 \
        --data-urlencode "query=SELECT toString(max(extracted_at)) FROM fact_machine_usage" \
        "$base_url/?database=laundrytwin_analytics")" || {
        echo "restore-guards: cannot query $base_url" >&2
        return 1
    }
    restored_max="$(printf '%s' "$body" | tr -d '[:space:]')"

    if [[ -z "$restored_max" ]]; then
        echo "restore-guards: restored warehouse returned no max(extracted_at) — refusing." >&2
        return 1
    fi

    echo "restore-guards: restored max(extracted_at)=$restored_max"
    echo "restore-guards: pre-restore boundary          =$pre_boundary"

    # Normalize: strip timezone suffix / T for consistent lexical compare
    local restored_norm pre_norm
    restored_norm="$(printf '%s' "$restored_max" | sed 's/T/ /;s/Z$//;s/+.*//')"
    pre_norm="$(printf '%s' "$pre_boundary" | sed 's/T/ /;s/Z$//;s/+.*//')"

    if [[ "$restored_norm" < "$pre_norm" ]]; then
        echo "restore-guards: REFUSING compose switch — restored warehouse is behind pre-restore boundary." >&2
        return 1
    fi

    echo "restore-guards: post-restore continuity OK (restored >= pre-restore)"
}
