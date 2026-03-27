#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PG_BIN=/tool/pandora64/bin
PG_PORT=${PG_PORT:-15432}
PG_DATA="/tmp/plansync-pgdata-$(whoami)"

cd "$PROJECT_DIR"

echo "========================================="
echo "  PlanSync 开发环境初始化"
echo "========================================="

# ① 检查并激活 Node 18
echo ""
echo "[1/7] 检查 Node.js 版本..."
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
NODE_MAJOR=$(node -v 2>/dev/null | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo "  当前 Node $(node -v)，切换到 Node 18..."
  nvm use 18
fi
echo "  ✓ Node $(node -v), npm $(npm -v)"

# ② 修复 npm cache 路径（NFS 不兼容 npm 缓存，必须移到本地磁盘）
echo ""
echo "[2/7] 修复 npm cache 路径..."
NPM_CACHE_DIR="/tmp/npm-cache-$(whoami)"
mkdir -p "$NPM_CACHE_DIR"
npm config set cache "$NPM_CACHE_DIR"
echo "cache=/tmp/npm-cache-\${USER}" > "$PROJECT_DIR/.npmrc"
echo "  ✓ npm cache 已设置为 $NPM_CACHE_DIR（避免 NFS 缓存损坏）"

# ③ 安装依赖
echo ""
echo "[3/7] 安装依赖（npm workspaces）..."
npm install --cache "$NPM_CACHE_DIR"
echo "  ✓ 依赖已安装"

# ④ 配置环境变量
echo ""
echo "[4/7] 配置环境变量..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  ✓ .env 已从模板创建（默认配置，通常不需要修改）"
else
  echo "  ✓ .env 已存在，跳过"
fi

# ⑤ 启动 PostgreSQL（本地磁盘，非 NFS）
echo ""
echo "[5/7] 启动 PostgreSQL..."
export PATH="$PG_BIN:$PATH"
if pg_isready -p "$PG_PORT" -q 2>/dev/null; then
  echo "  ✓ PostgreSQL 已在端口 $PG_PORT 运行"
else
  if [ ! -d "$PG_DATA" ]; then
    echo "  首次运行，初始化数据目录: $PG_DATA"
    initdb -D "$PG_DATA" > /dev/null 2>&1
  fi
  pg_ctl -D "$PG_DATA" -l "$PG_DATA/logfile" -o "-p $PG_PORT" start > /dev/null 2>&1
  echo "  ✓ PostgreSQL 已启动（端口 $PG_PORT）"
fi
# 确保数据库存在
createdb -p "$PG_PORT" plansync_dev 2>/dev/null || true
echo "  ✓ 数据库 plansync_dev 就绪"

# ⑥ 数据库 migration + seed
echo ""
echo "[6/7] 初始化数据库 schema..."
cd packages/api
npx prisma migrate deploy
npx prisma db seed 2>/dev/null || echo "  (seed 可选，跳过)"
cd "$PROJECT_DIR"
echo "  ✓ 数据库 schema 已就绪"

# ⑦ 完成
echo ""
echo "[7/7] 初始化 Git hooks..."
npx husky 2>/dev/null || true
echo "  ✓ Git hooks 已配置"

echo ""
echo "========================================="
echo "  ✓ 初始化完成！"
echo ""
echo "  启动开发：npm run dev"
echo "  停止数据库：npm run db:stop"
echo "  交互式 SQL：npm run db:psql"
echo "========================================="
