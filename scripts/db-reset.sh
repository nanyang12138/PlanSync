#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=scripts/pg-env.sh
. "$SCRIPT_DIR/pg-env.sh"
PG_DATA="$(resolve_pg_data)"

bash "$SCRIPT_DIR/pg-stop.sh"
rm -rf "$PG_DATA"

# Kill lingering node processes from .local-runtime (NFS: prevents silly-rename lockout)
pkill -f "$PROJECT_DIR/.local-runtime" 2>/dev/null || true
sleep 1
# NFS-safe removal. If a process still holds a binary open, `rm -rf` silly-renames
# it to a .nfsXXXX file and fails with "Directory not empty" — which under
# `set -euo pipefail` would abort the whole reset and leave a half-deleted runtime
# that breaks the next `ps-admin start`. Rename aside (always succeeds, even with
# open files), then best-effort purge; never let a stuck .nfs file abort the reset.
if [ -e "$PROJECT_DIR/.local-runtime" ]; then
  mv "$PROJECT_DIR/.local-runtime" "$PROJECT_DIR/.local-runtime.stale-$$" 2>/dev/null || true
  rm -rf "$PROJECT_DIR/.local-runtime" "$PROJECT_DIR/.local-runtime.stale-"* 2>/dev/null || true
fi

bash "$SCRIPT_DIR/setup.sh"
