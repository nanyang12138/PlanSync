#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/pg-env.sh"
PG_BIN="$(detect_pg_bin || true)"
if [ -z "$PG_BIN" ]; then
  echo "Could not locate psql — set PG_BIN to your PostgreSQL bin directory." >&2
  exit 1
fi
export PATH="$PG_BIN:$PATH"
exec psql -p "${PG_PORT:-15432}" plansync_dev
