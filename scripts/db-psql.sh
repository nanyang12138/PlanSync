#!/bin/bash
set -euo pipefail

PG_BIN="${PG_BIN:-/tool/pandora64/bin}"
export PATH="$PG_BIN:$PATH"
exec psql -p "${PG_PORT:-15432}" plansync_dev
