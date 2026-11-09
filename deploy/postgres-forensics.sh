#!/usr/bin/env bash
# postgres-forensics.sh — bounded sampling harness around analytics-postgres-1.
#
# WHY. The Airflow metadata cluster reinitialises itself (four sites: 2026-09-06
# onwards, 61 reinits by 2026-09-30, 2 more inside the container that started
# 2026-11-06 14:51). The dying backend writes no line of its own, so a `docker
# logs` read after the fact cannot attribute the death — and at 2026-11-09 04:04
# dockerd had already logged `stream copy error: reading from a closed fifo` for
# this container, so the log channel itself was broken two minutes before the
# reinit at 04:06:26. This harness samples the things a log cannot retroactively
# answer: container memory against its cgroup limit, the OOM counters, the
# backend count, per-database activity deltas, and the kernel's own verdict.
#
# It is a SCRIPT, not a daemon: it runs for a bounded number of samples, appends
# one NDJSON line per sample, and exits. Nothing is restarted, nothing is
# written inside the container, and no secret is read or printed.
#
# WHAT IT DOES NOT DO. It cannot invent a cause. If no reinit happens while it
# runs, the output is a baseline, not an attribution — say so.
#
# USAGE
#   sudo bash deploy/postgres-forensics.sh                 # 40 samples x 30 s = 20 min
#   sudo bash deploy/postgres-forensics.sh --samples 2880 --interval-seconds 30   # 24 h
#   sudo bash deploy/postgres-forensics.sh --out /opt/laundrytwin/postgres-forensics
#
# Every sample is one line of JSON so a later reader can `jq` it without a parser.

set -euo pipefail

CONTAINER="${CONTAINER:-analytics-postgres-1}"
INTERVAL_SECONDS=30
SAMPLES=40
MAX_DIR_BYTES=$((20 * 1024 * 1024)) # 20 MB cap: this host has 7.6 GB free
OUT_DIR="${OUT_DIR:-/opt/laundrytwin/postgres-forensics}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --samples) SAMPLES="$2"; shift 2 ;;
        --interval-seconds) INTERVAL_SECONDS="$2"; shift 2 ;;
        --out) OUT_DIR="$2"; shift 2 ;;
        --container) CONTAINER="$2"; shift 2 ;;
        -h|--help) sed -n '1,30p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$OUT_DIR/sample-$STAMP.ndjson"
echo "sampling $CONTAINER every ${INTERVAL_SECONDS}s for $SAMPLES samples -> $OUT_FILE" >&2

# One JSON field per observation. `psql` is used inside the container so the
# credentials never leave it and this script never needs a password.
pg_scalar() {
    docker exec "$CONTAINER" psql -U airflow -d airflow -tAc "$1" 2>/dev/null | tr -d '\r\n'
}

# cgroup v2 counters survive for the life of the container, so `oom_kill` here is
# a retroactive answer to "was this container's cgroup the killer", not a
# point-in-time reading.
cgroup_field() {
    docker exec "$CONTAINER" sh -c "cat /sys/fs/cgroup/$1 2>/dev/null" 2>/dev/null | tr -d '[:space:]'
}

prune() {
    local total
    total="$(du -sk "$OUT_DIR" 2>/dev/null | awk '{print $1 * 1024}')"
    if [[ -n "$total" ]] && (( total > MAX_DIR_BYTES )); then
        # Oldest first; keep the newest file even if it alone is large.
        ls -1t "$OUT_DIR"/sample-*.ndjson 2>/dev/null | tail -n +2 | head -n 1 | while read -r old; do
            echo "pruning $old (dir over cap)" >&2
            rm -f "$old"
        done
    fi
}

for ((i = 1; i <= SAMPLES; i++)); do
    at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    mem_current="$(cgroup_field memory.current)"
    mem_peak="$(cgroup_field memory.peak)"
    mem_max="$(cgroup_field memory.max)"
    # memory.events is line-structured ("oom_kill 3"), so it is read raw and
    # parsed by field name. Joining the lines first would make awk read the
    # whole block as one record and return "low"'s value instead — a field that
    # is always 0, which would silently report "no OOM" forever.
    mem_events="$(docker exec "$CONTAINER" sh -c 'cat /sys/fs/cgroup/memory.events 2>/dev/null' 2>/dev/null || echo '')"
    oom_kills="$(printf '%s\n' "$mem_events" | awk '$1 == "oom_kill" {print $2}' | head -n 1)"

    stats="$(docker stats --no-stream --format '{{.MemUsage}}|{{.CPUPerc}}' "$CONTAINER" 2>/dev/null || echo 'unavailable|')"
    state="$(docker inspect "$CONTAINER" --format '{{.RestartCount}}|{{.State.OOMKilled}}|{{.State.StartedAt}}' 2>/dev/null || echo '?|?|?')"
    postmaster_start="$(pg_scalar 'select pg_postmaster_start_time()' || echo unknown)"
    backends="$(pg_scalar "select count(*) from pg_stat_activity where backend_type = 'client backend'" || echo 0)"
    waiting="$(pg_scalar "select count(*) from pg_stat_activity where wait_event_type is not null" || echo 0)"
    longest="$(pg_scalar "select coalesce(max(extract(epoch from (now() - query_start)))::int, 0) from pg_stat_activity where state = 'active'" || echo 0)"
    xact="$(pg_scalar "select coalesce(sum(xact_commit + xact_rollback), 0) from pg_stat_database" || echo 0)"
    temp_files="$(pg_scalar "select coalesce(sum(temp_files), 0) from pg_stat_database" || echo 0)"
    deadlocks="$(pg_scalar "select coalesce(sum(deadlocks), 0) from pg_stat_database" || echo 0)"
    # Kernel verdicts since the last read; `-T` gives wall-clock timestamps so
    # this correlates with the reinit times without a second conversion.
    kernel="$(dmesg -T 2>/dev/null | tail -n 5 | tr '"' "'" | tr '\n' ';' || echo '')"

    printf '{"at":"%s","container":"%s","mem_current":%s,"mem_peak":%s,"mem_max":%s,"oom_kills":%s,"mem_usage":"%s","restart_count":"%s","started_at":"%s","postmaster_start":"%s","backends":%s,"waiting":%s,"longest_active_s":%s,"xact_total":%s,"temp_files":%s,"deadlocks":%s,"kernel":"%s"}\n' \
        "$at" "$CONTAINER" "${mem_current:-0}" "${mem_peak:-0}" "${mem_max:-0}" "${oom_kills:-0}" \
        "$(printf '%s' "$stats" | cut -d'|' -f1)" \
        "$(printf '%s' "$state" | cut -d'|' -f1)" \
        "$(printf '%s' "$state" | cut -d'|' -f3)" \
        "$postmaster_start" "$backends" "$waiting" "$longest" "$xact" "$temp_files" "$deadlocks" \
        "$kernel" >>"$OUT_FILE"

    prune
    if (( i < SAMPLES )); then
        sleep "$INTERVAL_SECONDS"
    fi
done

echo "wrote $SAMPLES samples to $OUT_FILE ($(wc -l <"$OUT_FILE") lines, $(du -h "$OUT_FILE" | cut -f1))" >&2
