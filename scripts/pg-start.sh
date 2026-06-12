#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/pg-env.sh
. "$SCRIPT_DIR/pg-env.sh"
PG_BIN="$(detect_pg_bin || true)"
if [ -z "$PG_BIN" ]; then
  echo "✗ Could not locate a PostgreSQL install (pg_ctl not found)." >&2
  echo "  Install Postgres or export PG_BIN to its bin directory." >&2
  exit 1
fi
PG_PORT=${PG_PORT:-15432}
PG_DATA="$(resolve_pg_data)"

export PATH="$PG_BIN:$PATH"

if pg_isready -p "$PG_PORT" -q 2>/dev/null; then
  # Verify the running instance uses our data directory (not another user's)
  RUNNING_POSTMASTER="$PG_DATA/postmaster.pid"
  if [ ! -f "$RUNNING_POSTMASTER" ]; then
    echo "✗ Port $PG_PORT is already in use by another user's PostgreSQL instance."
    echo "  Set a unique PG_PORT in your .env, e.g.:"
    echo "    PG_PORT=\$(expr 15000 + \$(id -u) % 1000)"
    exit 1
  fi
  echo "✓ PostgreSQL already running on port $PG_PORT"
else
  if [ ! -d "$PG_DATA" ]; then
    echo "⚠ Database not initialized. Run first: ./bin/ps-admin start"
    exit 1
  fi
  pg_ctl -D "$PG_DATA" -l "$PG_DATA/logfile" -o "-p $PG_PORT" start > /dev/null 2>&1
  echo "✓ PostgreSQL started (port $PG_PORT)"
fi
