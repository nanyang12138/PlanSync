#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PG_BIN=/tool/pandora64/bin
PG_PORT=${PG_PORT:-15432}
PG_DATA="/tmp/plansync-pgdata-$(whoami)"

cd "$PROJECT_DIR"

echo "========================================="
echo "  PlanSync Dev Environment Setup"
echo "========================================="

echo ""
echo "[1/7] Checking Node.js version..."
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
NODE_MAJOR=$(node -v 2>/dev/null | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo "  Current Node $(node -v), switching to Node 18..."
  nvm use 18
fi
echo "  ✓ Node $(node -v), npm $(npm -v)"

# Fix npm cache path (NFS is incompatible with npm cache, must use local disk)
echo ""
echo "[2/7] Fixing npm cache path..."
NPM_CACHE_DIR="/tmp/npm-cache-$(whoami)"
mkdir -p "$NPM_CACHE_DIR"
npm config set cache "$NPM_CACHE_DIR"
echo "cache=/tmp/npm-cache-\${USER}" > "$PROJECT_DIR/.npmrc"
echo "  ✓ npm cache set to $NPM_CACHE_DIR (avoids NFS cache corruption)"

echo ""
echo "[3/7] Installing dependencies (npm workspaces)..."
npm install --cache "$NPM_CACHE_DIR"
echo "  ✓ Dependencies installed"

echo ""
echo "[4/7] Configuring environment variables..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  ✓ .env created from template (defaults work for local dev)"
else
  echo "  ✓ .env already exists, skipping"
fi

echo ""
echo "[5/7] Starting PostgreSQL..."
export PATH="$PG_BIN:$PATH"
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
echo "[6/7] Initializing database schema..."
cd packages/api
npx prisma migrate deploy
npx prisma db seed 2>/dev/null || echo "  (seed is optional, skipping)"
cd "$PROJECT_DIR"
echo "  ✓ Database schema ready"

echo ""
echo "[7/7] Initializing Git hooks..."
npx husky 2>/dev/null || true
echo "  ✓ Git hooks configured"

echo ""
echo "========================================="
echo "  ✓ Setup complete!"
echo ""
echo "  Start dev server:  npm run dev"
echo "  Stop database:     npm run db:stop"
echo "  Interactive SQL:   npm run db:psql"
echo "========================================="
