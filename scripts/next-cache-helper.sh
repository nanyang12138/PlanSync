#!/usr/bin/env bash
# R-103: helpers that let dev.sh decide whether to clear the Next.js build
# cache instead of unconditionally rm -rf'ing it on every `bash scripts/dev.sh`
# invocation.
#
# The previous behaviour wiped the cache every run, which made the dev loop
# slow (~5-15s per restart) even when nothing about the build configuration
# had actually changed. Empirically the only thing that *forces* a clean
# rebuild is a change to next.config.js (Next.js itself notices most other
# changes via its file watcher). So we keep a sha256 marker of the relevant
# config files inside BUILD_DIR and only clear when the marker disagrees with
# the current config. The first time the helper sees an existing cache with
# no marker we conservatively clear once so a stale pre-R-103 cache cannot
# silently survive.
#
# This file is intentionally pure shell (no node / no jq) so it works inside
# bin/ps-admin first-run before Node is bootstrapped, and so it is testable
# in isolation via vitest (see packages/api/tests/unit/next-cache-helper.test.ts).

PLANSYNC_NEXT_CACHE_MARKER_NAME="${PLANSYNC_NEXT_CACHE_MARKER_NAME:-.plansync-next-config.sha256}"

# Print the sha256 of all listed files concatenated. Missing files are
# silently skipped. Exits non-zero when none of the inputs exist so callers
# can distinguish "no signal at all" from "fresh hash". The pre-flight loop
# is intentional: piping `cat` straight into `sha256sum` would mask a fully
# missing input set (sha256sum on empty stdin is a real, stable digest).
__plansync_next_cache_hash() {
  local f
  local found=0
  for f in "$@"; do
    if [ -f "$f" ]; then
      found=1
      break
    fi
  done
  if [ "$found" -eq 0 ]; then
    return 1
  fi
  local hash
  hash=$(
    for f in "$@"; do
      if [ -f "$f" ]; then
        cat "$f"
      fi
    done | sha256sum | awk '{print $1}'
  )
  if [ -z "$hash" ]; then
    return 1
  fi
  printf '%s\n' "$hash"
}

# should_clear_next_cache <build_dir> <config_file> [more config files...]
#
# Exit codes:
#   0  cache must be cleared (drift detected, or first run after R-103 with
#      a pre-existing cache that has no marker yet, or hashing failed and
#      we're being conservative)
#   1  cache is fresh and should be reused
should_clear_next_cache() {
  local build_dir="$1"
  shift || return 1
  if [ -z "$build_dir" ] || [ ! -d "$build_dir" ]; then
    # No cache directory yet — nothing to clear, the upcoming build will
    # populate it from scratch anyway.
    return 1
  fi
  if [ "$#" -eq 0 ]; then
    # No config files supplied — caller error; do not clear.
    return 1
  fi
  local marker="$build_dir/$PLANSYNC_NEXT_CACHE_MARKER_NAME"
  if [ ! -f "$marker" ]; then
    # Pre-R-103 cache directory with no marker — clear once so a stale
    # cache from a prior config can't silently survive the upgrade.
    return 0
  fi
  local current_hash
  current_hash=$(__plansync_next_cache_hash "$@" 2>/dev/null) || return 0
  if [ -z "$current_hash" ]; then
    return 0
  fi
  local previous_hash
  previous_hash=$(tr -d '[:space:]' < "$marker" 2>/dev/null)
  if [ "$current_hash" = "$previous_hash" ]; then
    return 1
  fi
  return 0
}

# write_next_cache_marker <build_dir> <config_file> [more config files...]
#
# Records the current hash of the supplied config files into BUILD_DIR so the
# next invocation of should_clear_next_cache can detect drift. Always exits 0;
# silent no-op if BUILD_DIR doesn't exist (dev.sh creates it just-in-time).
write_next_cache_marker() {
  local build_dir="$1"
  shift || return 0
  if [ -z "$build_dir" ]; then
    return 0
  fi
  if [ ! -d "$build_dir" ]; then
    return 0
  fi
  if [ "$#" -eq 0 ]; then
    return 0
  fi
  local marker="$build_dir/$PLANSYNC_NEXT_CACHE_MARKER_NAME"
  local current_hash
  current_hash=$(__plansync_next_cache_hash "$@" 2>/dev/null) || return 0
  if [ -n "$current_hash" ]; then
    printf '%s\n' "$current_hash" > "$marker"
  fi
}
