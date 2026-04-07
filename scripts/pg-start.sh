#!/bin/bash
set -e

PG_BIN="${PG_BIN:-/tool/pandora64/bin}"
PG_PORT=${PG_PORT:-15432}
PG_DATA="/tmp/plansync-pgdata-$(whoami)"

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
