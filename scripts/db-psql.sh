#!/bin/bash
# Convenience wrapper for `psql` against the local plansync_dev DB.
# Forwards every CLI argument to psql (including `-c "SQL"` from README
# examples), so `bash scripts/db-psql.sh -c "SELECT 1"` works as
# advertised.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=local-node-runtime.sh
. "$SCRIPT_DIR/local-node-runtime.sh"

if [ -z "${PG_BIN:-}" ]; then
  echo "✗ PostgreSQL toolchain not found. Tried PG_BIN, PG_BIN_CANDIDATES," >&2
  echo "  and the PATH. Install postgresql or set PG_BIN explicitly." >&2
  exit 1
fi

export PATH="$PG_BIN:$PATH"
exec psql -p "${PG_PORT:-15432}" plansync_dev "$@"
