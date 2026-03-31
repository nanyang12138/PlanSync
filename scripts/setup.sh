#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PG_BIN="${PG_BIN:-/tool/pandora64/bin}"
PG_PORT=${PG_PORT:-15432}
PG_DATA="/tmp/plansync-pgdata-$(whoami)"

# shellcheck source=scripts/local-node-runtime.sh
. "$SCRIPT_DIR/local-node-runtime.sh"

cd "$PROJECT_DIR"

echo "========================================="
echo "  PlanSync Dev Environment Setup"
echo "========================================="

echo ""
echo "[1/8] Installing local Node.js runtime..."
install_local_node_runtime
use_local_node_runtime
echo "  ✓ Node $(run_local_node -v), npm $(run_local_npm -v)"

echo ""
echo "[2/8] Preparing npm cache..."
echo "  ✓ npm cache set to $LOCAL_NPM_CACHE"

echo ""
echo "[3/8] Installing dependencies (npm workspaces)..."
run_local_npm install --cache "$LOCAL_NPM_CACHE"
echo "  ✓ Dependencies installed"

echo ""
echo "[4/8] Configuring environment variables..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  ✓ .env created from template (defaults work for local dev)"
else
  echo "  ✓ .env already exists, skipping"
fi

echo ""
echo "[5/8] Starting PostgreSQL..."
export PATH="$LOCAL_NODE_DIR/bin:$PG_BIN:$PATH"
if pg_isready -p "$PG_PORT" -q 2>/dev/null; then
  echo "  ✓ PostgreSQL already running on port $PG_PORT"
else
  if [ ! -d "$PG_DATA" ]; then
    echo "  First run — initializing data directory: $PG_DATA"
    initdb -D "$PG_DATA" > /dev/null 2>&1
  fi
  pg_ctl -D "$PG_DATA" -l "$PG_DATA/logfile" -o "-p $PG_PORT" start > /dev/null 2>&1
  echo "  ✓ PostgreSQL started (port $PG_PORT)"
fi
createdb -p "$PG_PORT" plansync_dev 2>/dev/null || true
echo "  ✓ Database plansync_dev ready"

echo ""
echo "[6/8] Building local workspace packages..."
if [ ! -f "$PROJECT_DIR/packages/shared/package.json" ]; then
  echo "  ✗ Shared workspace not found"
  exit 1
fi
run_local_npm run --workspace=@plansync/shared build
run_local_npm run --workspace=@plansync/mcp-server build
echo "  ✓ Shared and MCP packages built"

echo ""
echo "[7/8] Initializing database schema..."
if [ ! -f "$PROJECT_DIR/node_modules/prisma/build/index.js" ]; then
  echo "  ✗ Prisma CLI not found in local dependencies"
  exit 1
fi
run_local_prisma generate --schema "$PROJECT_DIR/packages/api/prisma/schema.prisma"
run_local_prisma migrate deploy --schema "$PROJECT_DIR/packages/api/prisma/schema.prisma"
(
  cd "$PROJECT_DIR/packages/api"
  set -a
  . "$PROJECT_DIR/.env"
  set +a
  export PATH="$LOCAL_NODE_DIR/bin:$PATH"
  export npm_config_cache="$LOCAL_NPM_CACHE"
  run_local_prisma db seed --schema "$PROJECT_DIR/packages/api/prisma/schema.prisma"
) 2>/dev/null || echo "  (seed is optional, skipping)"
echo "  ✓ Database schema ready"

echo ""
echo "[8/8] Initializing Git hooks..."
if [ -x "$PROJECT_DIR/node_modules/.bin/husky" ]; then
  "$PROJECT_DIR/node_modules/.bin/husky" 2>/dev/null || true
fi
echo "  ✓ Git hooks configured"

echo ""
echo "========================================="
echo "  ✓ Setup complete!"
echo ""
echo "  Preferred start:   ./bin/ps-admin start"
echo "  Direct API start:  bash scripts/dev.sh"
echo "  Stop database:     bash scripts/pg-stop.sh"
echo "  Interactive SQL:   bash scripts/db-psql.sh"
echo "========================================="
