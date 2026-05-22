#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=scripts/pg-env.sh
. "$SCRIPT_DIR/pg-env.sh"
PG_BIN="$(detect_pg_bin || true)"
if [ -z "$PG_BIN" ]; then
  echo "✗ Could not locate a PostgreSQL install (pg_ctl not found)." >&2
  echo "  Install Postgres or export PG_BIN to its bin directory." >&2
  exit 1
fi
PORT="${PORT:-3001}"
PG_PORT=${PG_PORT:-15432}
PG_DATA="/tmp/plansync-pgdata-$(whoami)"

# shellcheck source=scripts/local-node-runtime.sh
. "$SCRIPT_DIR/local-node-runtime.sh"

require_local_node_runtime
use_local_node_runtime

# Auto-start PostgreSQL if not running
export PATH="$LOCAL_NODE_DIR/bin:$PG_BIN:$PATH"
if ! pg_isready -p "$PG_PORT" -q 2>/dev/null; then
  if [ ! -d "$PG_DATA" ]; then
    echo "⚠ Database not initialized. Run first: ./bin/ps-admin start"
    exit 1
  fi
  echo "Starting PostgreSQL..."
  pg_ctl -D "$PG_DATA" -l "$PG_DATA/logfile" -o "-p $PG_PORT" start > /dev/null 2>&1
fi

# Load environment variables from root .env (bash expands ${USER} etc.)
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck source=../.env
  . "$PROJECT_DIR/.env"
  set +a
fi

# Clear stale Next.js webpack cache (module IDs shift when new files are added)
BUILD_DIR="$PROJECT_DIR/packages/api/tmp/ps-next-build-$(whoami)"
if [ -d "$BUILD_DIR" ]; then
  echo "Clearing stale Next.js build cache..."
  rm -rf "$BUILD_DIR"
fi

# Ensure migrations are up to date
if [ ! -f "$PROJECT_DIR/node_modules/prisma/build/index.js" ]; then
  echo "Prisma CLI not found in local dependencies"
  echo "Run: ./bin/ps-admin start"
  exit 1
fi
run_local_prisma migrate deploy --schema "$PROJECT_DIR/packages/api/prisma/schema.prisma"
run_local_prisma generate --schema "$PROJECT_DIR/packages/api/prisma/schema.prisma"

exec "$LOCAL_NPM_BIN" run --workspace=@plansync/api dev -- --port "$PORT"
