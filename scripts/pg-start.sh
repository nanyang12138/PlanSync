#!/bin/bash
set -e

PG_BIN=/tool/pandora64/bin
PG_PORT=${PG_PORT:-15432}
PG_DATA="/tmp/plansync-pgdata-$(whoami)"

export PATH="$PG_BIN:$PATH"

if pg_isready -p "$PG_PORT" -q 2>/dev/null; then
  echo "✓ PostgreSQL 已在端口 $PG_PORT 运行"
else
  if [ ! -d "$PG_DATA" ]; then
    echo "⚠ 数据库未初始化，请先运行: ./scripts/setup.sh"
    exit 1
  fi
  pg_ctl -D "$PG_DATA" -l "$PG_DATA/logfile" -o "-p $PG_PORT" start > /dev/null 2>&1
  echo "✓ PostgreSQL 已启动（端口 $PG_PORT）"
fi
