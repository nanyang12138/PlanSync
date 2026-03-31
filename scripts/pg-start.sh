#!/bin/bash
set -e

PG_BIN="${PG_BIN:-/tool/pandora64/bin}"
PG_PORT=${PG_PORT:-15432}
PG_DATA="/tmp/plansync-pgdata-$(whoami)"

export PATH="$PG_BIN:$PATH"

if pg_isready -p "$PG_PORT" -q 2>/dev/null; then
  echo "✓ PostgreSQL already running on port $PG_PORT"
else
  if [ ! -d "$PG_DATA" ]; then
    echo "⚠ Database not initialized. Run first: ./bin/ps-admin start"
    exit 1
  fi
  pg_ctl -D "$PG_DATA" -l "$PG_DATA/logfile" -o "-p $PG_PORT" start > /dev/null 2>&1
  echo "✓ PostgreSQL started (port $PG_PORT)"
fi
