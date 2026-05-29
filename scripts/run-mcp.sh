#!/bin/bash
# Portable MCP server launcher for PlanSync.
# Resolves paths relative to the repo root so it works on any machine.
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"

# Load project .env first (lower priority — e.g. AUTH_DISABLED for local
# no-auth demo mode). User credentials below override any shared values.
if [ -f "$REPO/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$REPO/.env"
  set +a
fi

# Load user credentials saved by ./bin/plansync (first-time setup).
# set -a exports every variable sourced from the file to child processes.
if [ -f "$HOME/.config/plansync/env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$HOME/.config/plansync/env"
  set +a
fi

# Use local runtime node if available, else fall back to system node
NODE="$REPO/.local-runtime/node/bin/node"
if [ ! -x "$NODE" ]; then
  NODE="node"
fi

exec "$NODE" "$REPO/packages/mcp-server/dist/index.js" "$@"
