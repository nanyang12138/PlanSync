#!/bin/bash
# Shared PostgreSQL detection helpers. Source this file from any script that
# needs to locate `pg_ctl`, `psql`, `pg_isready`, etc. on heterogeneous hosts
# (AMD internal builds, Linux distro packages, Homebrew macOS, etc.).
#
# Usage:
#   . "$SCRIPT_DIR/pg-env.sh"
#   PG_BIN="$(detect_pg_bin)"
#
# Honors caller-provided $PG_BIN — if already set and the directory contains
# pg_ctl, it is returned as-is. Otherwise probes a portable list of common
# install locations. Falls back to `pg_config --bindir` when nothing else
# matches, so macOS/Homebrew/Postgres.app and custom builds work without
# requiring callers to export PG_BIN manually.

# Print a candidate PG bin directory containing pg_ctl, or empty string if
# nothing was found. Never exits the caller's shell (no `set -e` traps).
detect_pg_bin() {
  if [ -n "${PG_BIN:-}" ] && [ -x "$PG_BIN/pg_ctl" ]; then
    printf '%s' "$PG_BIN"
    return 0
  fi

  # PLANSYNC_PG_BIN_CANDIDATES_OVERRIDE — colon-separated override list,
  # used by tests so the "no postgres anywhere" path is reproducible on hosts
  # that happen to have a system Postgres install in one of the default
  # candidates. Empty string is a valid value (means: skip all candidates,
  # let pg_config fallback decide).
  local candidates
  if [ -n "${PLANSYNC_PG_BIN_CANDIDATES_OVERRIDE+x}" ]; then
    # IFS-split the colon list; empty string yields an empty array.
    IFS=":" read -r -a candidates <<<"$PLANSYNC_PG_BIN_CANDIDATES_OVERRIDE"
  else
    candidates=(
      "/tool/pandora64/bin"            # AMD internal
      "/usr/local/pgsql/bin"           # source-build default
      "/usr/lib/postgresql/16/bin"     # Debian/Ubuntu 16
      "/usr/lib/postgresql/15/bin"     # Debian/Ubuntu 15
      "/usr/lib/postgresql/14/bin"     # Debian/Ubuntu 14
      "/opt/homebrew/opt/postgresql@16/bin" # Homebrew arm64
      "/opt/homebrew/opt/postgresql@15/bin"
      "/opt/homebrew/opt/postgresql@14/bin"
      "/opt/homebrew/bin"              # Homebrew arm64 generic
      "/usr/local/opt/postgresql@16/bin" # Homebrew x86_64
      "/usr/local/opt/postgresql@15/bin"
      "/usr/local/opt/postgresql@14/bin"
      "/usr/local/bin"                 # Homebrew x86_64 generic
      "/Applications/Postgres.app/Contents/Versions/latest/bin" # Postgres.app
    )
  fi

  local dir
  for dir in "${candidates[@]}"; do
    if [ -x "$dir/pg_ctl" ]; then
      printf '%s' "$dir"
      return 0
    fi
  done

  # Final fallback: ask pg_config (works on any platform that has it in PATH)
  if command -v pg_config >/dev/null 2>&1; then
    local bindir
    bindir="$(pg_config --bindir 2>/dev/null || true)"
    if [ -n "$bindir" ] && [ -x "$bindir/pg_ctl" ]; then
      printf '%s' "$bindir"
      return 0
    fi
  fi

  return 1
}
