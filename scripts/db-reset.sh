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
rm -rf "$PROJECT_DIR/.local-runtime"

bash "$SCRIPT_DIR/setup.sh"
