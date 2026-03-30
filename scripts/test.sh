#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=scripts/local-node-runtime.sh
. "$SCRIPT_DIR/local-node-runtime.sh"

require_local_node_runtime
use_local_node_runtime

run_local_npm run test --workspaces --if-present
