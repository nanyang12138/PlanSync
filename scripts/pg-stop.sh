#!/bin/bash
PG_BIN="${PG_BIN:-/tool/pandora64/bin}"
PG_DATA="/tmp/plansync-pgdata-$(whoami)"
export PATH="$PG_BIN:$PATH"
if [ -d "$PG_DATA" ]; then
  pg_ctl -D "$PG_DATA" stop 2>/dev/null && echo "✓ PostgreSQL stopped" || echo "PostgreSQL is not running"
else
  echo "Data directory not found: $PG_DATA"
fi
