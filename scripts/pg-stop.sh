#!/bin/bash
# Stop the PostgreSQL instance for the current user. Honours $PG_BIN
# explicitly; otherwise probes the same set of well-known prefixes that
# local-node-runtime.sh and pg-start.sh use, so macOS / Homebrew /
# Red Hat hosts work without manual export.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=local-node-runtime.sh
. "$SCRIPT_DIR/local-node-runtime.sh"

PG_DATA="/tmp/plansync-pgdata-$(whoami)"

if [ -z "${PG_BIN:-}" ]; then
  echo "✗ PostgreSQL toolchain not found. Tried PG_BIN, PG_BIN_CANDIDATES," >&2
  echo "  and the PATH. Install postgresql or set PG_BIN explicitly." >&2
  exit 1
fi

export PATH="$PG_BIN:$PATH"
if [ -d "$PG_DATA" ]; then
  pg_ctl -D "$PG_DATA" stop 2>/dev/null && echo "✓ PostgreSQL stopped" || echo "PostgreSQL is not running"
else
  echo "Data directory not found: $PG_DATA"
fi
