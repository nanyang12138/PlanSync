#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/pg-env.sh"
PG_BIN="$(detect_pg_bin || true)"
if [ -z "$PG_BIN" ]; then
  echo "Could not locate pg_ctl — set PG_BIN to your PostgreSQL bin directory." >&2
  exit 1
fi
export PATH="$PG_BIN:$PATH"
PG_DATA="/tmp/plansync-pgdata-$(whoami)"
if [ -d "$PG_DATA" ]; then
  pg_ctl -D "$PG_DATA" stop 2>/dev/null && echo "✓ PostgreSQL stopped" || echo "PostgreSQL is not running"
else
  echo "Data directory not found: $PG_DATA"
fi
