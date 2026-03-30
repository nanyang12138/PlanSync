#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

bash "$SCRIPT_DIR/pg-stop.sh"
rm -rf "/tmp/plansync-pgdata-$(whoami)"
bash "$SCRIPT_DIR/setup.sh"
