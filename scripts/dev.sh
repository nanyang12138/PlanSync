#!/bin/bash
set -e

PG_BIN=/tool/pandora64/bin
PG_PORT=${PG_PORT:-15432}
PG_DATA="/tmp/plansync-pgdata-$(whoami)"

# 检查 Node 版本
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
NODE_MAJOR=$(node -v 2>/dev/null | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  nvm use 18 > /dev/null 2>&1
fi

# 确保 npm cache 在本地磁盘（NFS 不兼容）
export npm_config_cache="/tmp/npm-cache-$(whoami)"

# 自动启动 PostgreSQL（如果没在运行）
export PATH="$PG_BIN:$PATH"
if ! pg_isready -p "$PG_PORT" -q 2>/dev/null; then
  if [ ! -d "$PG_DATA" ]; then
    echo "⚠ 数据库未初始化，请先运行: ./scripts/setup.sh"
    exit 1
  fi
  echo "启动 PostgreSQL..."
  pg_ctl -D "$PG_DATA" -l "$PG_DATA/logfile" -o "-p $PG_PORT" start > /dev/null 2>&1
fi

# 检查 migration 是否最新
cd packages/api
npx prisma migrate deploy
cd ../..

# 启动 Next.js dev server
exec npm run --workspace=@plansync/api dev
