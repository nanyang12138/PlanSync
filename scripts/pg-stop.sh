#!/bin/bash
PG_BIN=/tool/pandora64/bin
PG_DATA="/tmp/plansync-pgdata-$(whoami)"
export PATH="$PG_BIN:$PATH"
if [ -d "$PG_DATA" ]; then
  pg_ctl -D "$PG_DATA" stop 2>/dev/null && echo "✓ PostgreSQL 已停止" || echo "PostgreSQL 未在运行"
else
  echo "未找到数据目录: $PG_DATA"
fi
