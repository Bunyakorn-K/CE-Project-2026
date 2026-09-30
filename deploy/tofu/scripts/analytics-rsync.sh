#!/usr/bin/env bash
# Sync deploy/analytics -> /opt/analytics behind a deletion gate.
#
# Usage: analytics-rsync.sh <src-dir> <dst-dir> <excludes-file> <allowlist-file>
#
# `rsync --delete` makes the destination a clone of the source. That is what we
# want for compose files and wrong for anything an operator put there by hand,
# so this script runs the sync in two passes:
#
#   1. dry run, itemised, with exactly the flags of the real sync, and print the
#      complete diff;
#   2. refuse unless every `*deleting` path appears in the allowlist, then run
#      the real sync.
#
# A refusal exits non-zero, which aborts `tofu apply` here - before the .env is
# installed and before `docker compose up -d` - so a refused sync leaves the
# running stack untouched. The dry run is also the evidence the operator is
# asked to read before approving an apply: it is the list of what the apply
# loses.
#
# With --itemize-changes, a removed path is reported as a single `*deleting`
# line and nothing else, so a removed directory shows up as that one directory
# path. Allowlist entries are therefore exact paths, never globs: an entry can
# never quietly cover a subtree.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <src-dir> <dst-dir> <excludes-file> <allowlist-file>" >&2
  exit 64
fi

src=$1
dst=$2
excludes=$3
allowlist=$4

for required in "$src" "$excludes" "$allowlist"; do
  if [ ! -e "$required" ]; then
    echo "ERROR: $required does not exist" >&2
    exit 66
  fi
done

echo "rsync $(rsync --version | head -1)"

rsync_flags=(-a --delete --itemize-changes --exclude-from="$excludes")

# Same flags as the real sync, so the printed deletions are the real ones.
dry=$(rsync "${rsync_flags[@]}" --dry-run "$src/" "$dst/")

echo "--- diff for $dst (dry run: nothing has been changed yet) ---"
if [ -z "$dry" ]; then
  echo "  (no changes: the destination already matches the source)"
else
  printf '%s\n' "$dry" | sed 's/^/  /'
fi
echo "--- end diff ---"

# `*deleting ` is the only itemize token that means a path is removed. The `|| true`
# is load-bearing: grep exits 1 when it selects nothing, and with pipefail that
# would kill the script on the very case where there is nothing to delete.
deleting=$(printf '%s\n' "$dry" | sed -n 's/^\*deleting  *//p' | sed 's:/$::' | grep -v '^$' | sort -u || true)
allowed=$(sed -e 's/#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$allowlist" | grep -v '^$' | sort -u || true)

# An empty list must stay empty: printf '%s\n' "" is one blank line, which comm
# would report as an unexpected path.
lines() { if [ -n "$1" ]; then printf '%s\n' "$1"; fi; }
unexpected=$(comm -23 <(lines "$deleting") <(lines "$allowed") || true)
unused=$(comm -13 <(lines "$deleting") <(lines "$allowed") || true)

print_list() { if [ -n "$1" ]; then printf '%s\n' "$1" | while IFS= read -r line; do printf '  %s\n' "$line"; done; fi; }

if [ -n "$unused" ]; then
  echo "NOTE: allowlist entries this sync does not delete (harmless):"
  print_list "$unused"
fi

if [ -n "$unexpected" ]; then
  {
    echo "REFUSED: the sync would delete these paths and they are not in $(basename "$allowlist"):"
    print_list "$unexpected"
    echo
    echo "Nothing has been changed: the dry run above is the complete list, and no file"
    echo "in $dst has been touched. For each path, either move whatever must survive"
    echo "into $(basename "$excludes") with a reason, or add the path to"
    echo "$(basename "$allowlist") with a reason, then re-run the apply."
  } >&2
  exit 1
fi

count=$(lines "$deleting" | grep -c . || true)
echo "deletion gate OK: ${count:-0} path(s) allowlisted for deletion"

rsync "${rsync_flags[@]}" "$src/" "$dst/"
echo "synced $src/ -> $dst/"
