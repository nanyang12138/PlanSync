#!/bin/bash
set -e

PG_BIN=/tool/pandora64/bin
PG_PORT=${PG_PORT:-15432}
PG_DATA="/tmp/plansync-pgdata-$(whoami)"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
NODE_MAJOR=$(node -v 2>/dev/null | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  nvm use 18 > /dev/null 2>&1
fi

export npm_config_cache="/tmp/npm-cache-$(whoami)"

# Auto-start PostgreSQL if not running
export PATH="$PG_BIN:$PATH"
if ! pg_isready -p "$PG_PORT" -q 2>/dev/null; then
  if [ ! -d "$PG_DATA" ]; then
    echo "⚠ Database not initialized. Run first: ./scripts/setup.sh"
    exit 1
  fi
  echo "Starting PostgreSQL..."
  pg_ctl -D "$PG_DATA" -l "$PG_DATA/logfile" -o "-p $PG_PORT" start > /dev/null 2>&1
fi

# Ensure migrations are up to date
cd packages/api
npx prisma migrate deploy
cd ../..

exec npm run --workspace=@plansync/api dev
