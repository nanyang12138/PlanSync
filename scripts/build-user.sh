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

# Trim leading + trailing whitespace.
#
# Closes #1169 #1156 #1127 — bash's POSIX `[[:space:]]` class only
# matches the ASCII whitespace set (space, tab, CR, LF, FF, VT), but
# JavaScript's `String.prototype.trim()` (used by next.config.js's
# resolveBuildUser) strips a wider set: NBSP (U+00A0), BOM (U+FEFF),
# and every Unicode whitespace code point in the
# `White_Space` property (U+1680, U+2000-U+200A, U+2028, U+2029,
# U+202F, U+205F, U+3000). Pre-fix, a `PLANSYNC_BUILD_USER` value
# with a leading NBSP slipped past the bash trim verbatim, while
# next.config.js trimmed it cleanly — re-introducing the exact
# build-cache split that #287 #466 #510 #526 #901 closed.
#
# We delegate to Node when available so the trim matches JS
# `.trim()` byte-for-byte. The repo always provisions a local Node
# runtime via scripts/local-node-runtime.sh; both dev.sh and
# build.sh source it before sourcing this file. The fallback to
# bash + POSIX `[:space:]` is kept for emergency tooling that runs
# without Node (e.g. one-off recovery scripts) — it still strips
# every ASCII whitespace, which is the dominant case in practice.
__plansync_trim() {
  local s="$1"
  if [ -z "$s" ]; then
    printf ''
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    # NUL-byte safe via env var (avoids argv quoting issues with
    # leading/trailing whitespace, BOM, etc.). The Node one-liner
    # is intentionally minimal — every fancier feature is one more
    # surface area for the wrapper to break.
    PLANSYNC_TRIM_IN="$s" node -e 'process.stdout.write((process.env.PLANSYNC_TRIM_IN||"").trim())' 2>/dev/null && return 0
  fi
  # Fallback: POSIX [:space:] only.
  s="${s#"${s%%[![:space:]]*}"}"
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
