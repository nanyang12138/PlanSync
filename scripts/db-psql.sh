#!/bin/bash
set -euo pipefail

PG_BIN="${PG_BIN:-$([ -x /tool/pandora64/bin/pg_ctl ] && echo /tool/pandora64/bin || echo /usr/lib/postgresql/16/bin)}"
export PATH="$PG_BIN:$PATH"
exec psql -p "${PG_PORT:-15432}" plansync_dev
