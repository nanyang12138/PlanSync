#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=scripts/local-node-runtime.sh
. "$SCRIPT_DIR/local-node-runtime.sh"

require_local_node_runtime
use_local_node_runtime

# F1 / closes #287 #289 #366 #540 #567 + 3 sibling findings: align the
# build-dir identity with dev.sh + next.config.js so a build invoked
# without a populated USER environment (cron, minimal CI runner,
# stripped-down Docker base) writes to and reads from the same
# directory dev.sh manages. next.config.js looks up
# PLANSYNC_BUILD_USER → USER → 'shared' in that order.
export PLANSYNC_BUILD_USER="${PLANSYNC_BUILD_USER:-${USER:-$(whoami)}}"
export USER="$PLANSYNC_BUILD_USER"

run_local_npm run --workspace=@plansync/shared build
run_local_npm run --workspace=@plansync/client-core build
run_local_npm run --workspace=@plansync/mcp-server build
run_local_npm run --workspace=@plansync/cli build
run_local_npm run --workspace=@plansync/api build
