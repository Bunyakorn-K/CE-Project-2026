#!/usr/bin/env bash
set -euo pipefail

check_reader_mount() {
  local compose_file="$1"
  local host_path="$2"

  if [[ ! -f "$host_path" ]]; then
    printf 'Refusing: reader.xml is not a regular file: %s\n' "$host_path" >&2
    return 1
  fi

  if ! grep -q "clickhouse-reader.xml:/etc/clickhouse-server/users.d/reader.xml" "$compose_file"; then
    printf 'Refusing: compose does not mount reader.xml: %s\n' "$compose_file" >&2
    return 1
  fi

  printf 'reader mount OK: %s is a regular file and mounted in %s\n' "$host_path" "$compose_file"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  compose_file="${1:?usage: check-reader-mount.sh <compose-file> <host-path>}"
  host_path="${2:?usage: check-reader-mount.sh <compose-file> <host-path>}"
  check_reader_mount "$compose_file" "$host_path"
fi
