#!/bin/bash
set -euo pipefail

export PATH="/tool/pandora64/bin:$PATH"
exec psql -p "${PG_PORT:-15432}" plansync_dev
