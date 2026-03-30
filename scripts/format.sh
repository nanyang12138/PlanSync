#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# shellcheck source=scripts/local-node-runtime.sh
. "$SCRIPT_DIR/local-node-runtime.sh"

require_local_node_runtime
use_local_node_runtime

run_local_node "$PROJECT_DIR/node_modules/prettier/bin/prettier.cjs" --write "packages/*/src/**/*.{ts,tsx}"
