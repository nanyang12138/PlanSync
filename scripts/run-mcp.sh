#!/bin/bash
# Portable MCP server launcher for PlanSync.
# Resolves paths relative to the repo root so it works on any machine.
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"

# Use local runtime node if available, else fall back to system node
NODE="$REPO/.local-runtime/node/bin/node"
if [ ! -x "$NODE" ]; then
  NODE="node"
fi

exec "$NODE" "$REPO/packages/mcp-server/dist/index.js" "$@"
