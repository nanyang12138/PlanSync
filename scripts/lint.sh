#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# shellcheck source=scripts/local-node-runtime.sh
. "$SCRIPT_DIR/local-node-runtime.sh"

require_local_node_runtime
use_local_node_runtime

run_local_node "$PROJECT_DIR/node_modules/eslint/bin/eslint.js" --max-warnings 0 packages/*/src

# Validate the cron-readable contract on docs/REMEDIATION_PLAN.md.
# Hard-fails on schema violations (status enum, dedup-field exclusivity,
# severity totals, depends_on cycles) but only warns about the legacy
# R-001..R-134 entries that pre-date the strict template.
run_local_node "$PROJECT_DIR/scripts/lint-remediation.mjs"
