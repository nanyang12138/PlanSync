#!/usr/bin/env bash
# scripts/build-user.sh — single source of truth for resolving the
# `PLANSYNC_BUILD_USER` value used by dev.sh, build.sh, and any other
# entry point that drives a Next.js build.
#
# Why this exists.  next.config.js (`packages/api/next.config.js`)
# resolves `process.env.PLANSYNC_BUILD_USER` with a TRIM step:
#
#     const explicit = (process.env.PLANSYNC_BUILD_USER || '').trim();
#     if (explicit) return explicit;
#     const fromUser = (process.env.USER || '').trim();
#     if (fromUser) return fromUser;
#     return 'shared';
#
# dev.sh and build.sh used to do `${PLANSYNC_BUILD_USER:-${USER:-$(whoami)}}`
# without trimming. Bash's `:-` only falls back when the variable is
# UNSET or empty — a value of `"   "` (whitespace) survives. The shell
# then computed `BUILD_DIR=…/ps-next-build-   ` while Next.js trimmed
# and computed `…/ps-next-build-shared`, splitting the cache and
# breaking dev-server reload.
#
# Closes #287 #466 #510 #526 #901 — every reviewer angle on the same
# trim-asymmetry between shell and JS.
#
# Usage (sourced, not exec'd):
#
#     . "$(dirname "$0")/build-user.sh"
#     export PLANSYNC_BUILD_USER="$(resolve_build_user)"
#
# The function emits exactly one of: the trimmed PLANSYNC_BUILD_USER,
# the trimmed USER, or the literal string `shared`. It never echoes
# whitespace, never echoes empty.

# Trim leading + trailing whitespace using only bash builtins (no
# subshell, no external `tr` — keeps this hot path fast on cron).
__plansync_trim() {
  local s="$1"
  # ltrim
  s="${s#"${s%%[![:space:]]*}"}"
  # rtrim
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

resolve_build_user() {
  local explicit fromuser
  explicit="$(__plansync_trim "${PLANSYNC_BUILD_USER:-}")"
  if [ -n "$explicit" ]; then
    printf '%s' "$explicit"
    return 0
  fi
  fromuser="$(__plansync_trim "${USER:-}")"
  if [ -n "$fromuser" ]; then
    printf '%s' "$fromuser"
    return 0
  fi
  # `whoami` is in coreutils on every linux base + macOS — the only
  # platforms PlanSync is run on. If it ever fails we fall through to
  # 'shared' rather than letting the script crash before next.config.js
  # gets its own chance.
  local who
  who="$(whoami 2>/dev/null || true)"
  who="$(__plansync_trim "$who")"
  if [ -n "$who" ]; then
    printf '%s' "$who"
    return 0
  fi
  printf 'shared'
}
