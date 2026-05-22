#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=scripts/local-node-runtime.sh
. "$SCRIPT_DIR/local-node-runtime.sh"

require_local_node_runtime
use_local_node_runtime

run_local_npm run test --workspaces --if-present

# Standalone tests for the cursor-review-triage helper scripts (no workspace,
# no external deps — uses node:test built into Node 22).
run_local_node --test "$SCRIPT_DIR"/*.test.mjs
