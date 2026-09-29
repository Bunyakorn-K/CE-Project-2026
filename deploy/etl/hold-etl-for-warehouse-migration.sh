#!/bin/sh
# Hold the ETL still while a fact_machine_usage column rebuild runs.
#
# WHY
#
# apps/api/scripts/migrate-usage-status-enum.ts renumbers the status Enum8 by
# adding a column, backfilling it with an ALTER ... UPDATE mutation, and then
# RENAMING the new column onto `status`. A ClickHouse mutation only rewrites the
# parts it snapshotted when it was submitted. A usage row the ETL writes after
# that snapshot is not rewritten, so it keeps the value the new column had
# before the backfill, and the rename reclassifies it — silently, with no error
# on either the write or the read.
#
# Reproduced end to end on a scratch table on ClickHouse 26.3: a `paid` row
# inserted after the mutation came out of the swap as `pending_payment`, taking
# one row out of `status IN ('paid','finished')` — a lost cycle and lost
# revenue, discovered only by noticing a number.
#
# WHY A PAUSE AND NOT A RECONCILIATION PASS
#
# A post-swap reconciliation pass can repair a missed row, but it has to run
# AFTER the rename and therefore after `DROP COLUMN`, which is irreversible: a
# missed row that the reconciliation itself gets wrong is unrecoverable without
# reloading from IRIS. Holding ingestion for a few seconds moves the whole
# exposure in front of the point of no return, where the migration aborts on its
# own distribution check with the old column still authoritative. The window
# here is seconds (a mutation over ~5k rows with mutations_sync=2), against an
# ETL cadence of one batch every 5 minutes.
#
# The trade is deliberate and asymmetric: the worst outcome of a pause is that
# ingestion is late by a few seconds, which the watermark resumes from; the
# worst outcome of not pausing is a wrong enum on real revenue data.
#
# WHAT IT DOES
#
#   - `stop`:  stop the ETL container, verify it is stopped
#   - `status`: report whether the ETL is running
#   - (the migration is run by the caller, between the two)
#   - `start`: start the ETL container and verify it is running again
#
# `start` is idempotent, and the `run` mode traps EXIT so a failing migration
# cannot leave ingestion stopped. Even so, check `status` afterwards: a stopped
# ETL writes no logs and looks identical to a healthy idle one.
#
# It touches exactly one container, the ETL, and issues nothing else: no other
# service is stopped, restarted or reconfigured, and no container is recreated.
#
# USAGE (on VM 117)
#
#   sudo sh deploy/etl/hold-etl-for-warehouse-migration.sh stop
#   CLICKHOUSE_URL=... CLICKHOUSE_USER=admin CLICKHOUSE_PASSWORD=... \
#     pnpm --filter @laundrytwin/api exec tsx scripts/migrate-usage-status-enum.ts --apply
#   sudo sh deploy/etl/hold-etl-for-warehouse-migration.sh start
#   sudo sh deploy/etl/hold-etl-for-warehouse-migration.sh status
#
# Or, to have the resume happen whatever the migration does:
#
#   sudo sh deploy/etl/hold-etl-for-warehouse-migration.sh run -- \
#     pnpm --filter @laundrytwin/api exec tsx scripts/migrate-usage-status-enum.ts --apply
#
set -eu

# The ETL service in /opt/laundrytwin/compose.yaml. `network_mode: host`,
# `restart: unless-stopped`: a manual `docker stop` is NOT undone by the restart
# policy, which is why the resume below is mandatory rather than decorative.
COMPOSE_FILE="${COMPOSE_FILE:-/opt/laundrytwin/compose.yaml}"
SERVICE="${SERVICE:-etl}"
WATERMARK="${WATERMARK:-/opt/laundrytwin-etl/data/etl-watermark.json}"

compose() {
  if [ -f "$COMPOSE_FILE" ]; then
    sudo -n docker compose -f "$COMPOSE_FILE" "$@"
  else
    # Fall back to the container name when the compose file is not where we
    # expect it. The service has a stable container name, so this still works.
    sudo -n docker "$@"
  fi
}

# Ask Docker for the container's real state, not compose's opinion of it.
# `docker compose ps` lists only RUNNING services, so a container this script
# has just stopped reads as "absent" rather than "exited" — which made the stop
# verification report `unknown` on a container that had stopped correctly, and
# turned a working stop into a refusal.
container_name() {
  # By compose label, not by name: the project name is not the directory name,
  # and `docker compose` v2 has no `inspect` subcommand to ask instead.
  sudo -n docker ps -a \
    --filter "label=com.docker.compose.service=$SERVICE" \
    --filter "label=com.docker.compose.project.config_files=$COMPOSE_FILE" \
    --format '{{.Names}}' 2>/dev/null | head -1
}

service_state() {
  name=$(container_name)
  [ -n "$name" ] || { echo "unknown"; return; }
  sudo -n docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo "unknown"
}

wait_for_state() {
  want="$1"
  limit="${2:-30}"
  i=0
  while [ "$i" -lt "$limit" ]; do
    if [ "$(service_state)" = "$want" ]; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

watermark_at() {
  if [ -f "$WATERMARK" ]; then
    # The usage cursor only. Never print the whole file: it is production state.
    tr ',' '\n' < "$WATERMARK" | sed -n 's/.*"at" *: *"\([^"]*\)".*/\1/p' | head -1
  else
    echo "(no watermark file)"
  fi
}

do_start() {
  echo "ETL watermark before start: $(watermark_at)"
  compose start "$SERVICE" >/dev/null
  if wait_for_state running 60; then
    echo "ETL: running"
  else
    echo "ETL: STILL NOT RUNNING after start — ingestion is stopped and needs attention" >&2
    return 1
  fi
}

do_stop() {
  compose stop "$SERVICE" >/dev/null
  if wait_for_state exited 60; then
    echo "ETL: stopped. Ingestion is paused; resume with: sh $0 start"
  else
    state=$(service_state)
    echo "ETL: state is $state, expected exited. Refusing to continue." >&2
    if [ "$state" != "exited" ]; then
      echo "      If '$state' is correct, fix SERVICE in this script." >&2
    fi
    return 1
  fi
}

do_run() {
  # The resume must happen whatever the migration does, including on a signal.
  trap 'do_start || true' EXIT INT TERM
  do_stop
  "$@"
}

case "${1:-}" in
  stop) do_stop ;;
  start) do_start ;;
  status)
    state=$(service_state)
    echo "ETL: $state"
    echo "watermark: $(watermark_at)"
    [ "$state" = running ] || exit 1
    ;;
  run)
    shift
    [ "${1:-}" = "--" ] && shift
    [ "$#" -gt 0 ] || { echo "usage: $0 run -- <command> [args...]" >&2; exit 2; }
    do_run "$@"
    ;;
  *)
    echo "usage: $0 {stop|start|status|run -- <command> [args...]}" >&2
    exit 2
    ;;
esac
