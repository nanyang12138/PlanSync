#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=scripts/pg-env.sh
. "$SCRIPT_DIR/pg-env.sh"
PG_BIN="$(detect_pg_bin || true)"
if [ -z "$PG_BIN" ]; then
  echo "✗ Could not locate a PostgreSQL install (pg_ctl not found)." >&2
  echo "  Install Postgres or export PG_BIN to its bin directory." >&2
  exit 1
fi
PORT="${PORT:-3001}"
PG_PORT=${PG_PORT:-15432}
PG_DATA="/tmp/plansync-pgdata-$(whoami)"

# shellcheck source=scripts/local-node-runtime.sh
. "$SCRIPT_DIR/local-node-runtime.sh"

require_local_node_runtime
use_local_node_runtime

# Auto-start PostgreSQL if not running
export PATH="$LOCAL_NODE_DIR/bin:$PG_BIN:$PATH"
if ! pg_isready -p "$PG_PORT" -q 2>/dev/null; then
  if [ ! -d "$PG_DATA" ]; then
    echo "⚠ Database not initialized. Run first: ./bin/ps-admin start"
    exit 1
  fi
  echo "Starting PostgreSQL..."
  pg_ctl -D "$PG_DATA" -l "$PG_DATA/logfile" -o "-p $PG_PORT" start > /dev/null 2>&1
fi

# Load environment variables from root .env (bash expands ${USER} etc.)
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck source=../.env
  . "$PROJECT_DIR/.env"
  set +a
fi

# R-103: only clear the Next.js build cache when the build configuration
# actually changed. The previous behaviour `rm -rf $BUILD_DIR` every run
# made `bash scripts/dev.sh` cold-start every time even when nothing about
# the project's config had moved, which forced a 5-15s rebuild loop on
# every restart. We now hash next.config.js (and the package metadata that
# Next.js bakes into its compile output) and only clear when the hash
# differs from the one stored alongside the cache directory.
# shellcheck source=scripts/next-cache-helper.sh
. "$SCRIPT_DIR/next-cache-helper.sh"
# F1 / closes #287 #289 #366 #540 #567 + 3 sibling findings on
# dev.sh ↔ next.config.js identity drift.
#
# next.config.js now reads `PLANSYNC_BUILD_USER` (with fallbacks
# `USER` → `'shared'`). We resolve once here and export it so:
#   1. The build directory we compute below matches exactly what
#      Next.js writes to (no more "we cleared one path, Next wrote
#      to another").
#   2. Any subprocess (`next start`, build worker, cron build) that
#      inherits this shell's env will agree on the same identity.
#   3. The fallback chain is the same in every entry point — dev.sh,
#      build.sh, ad-hoc npm run, cron — so a missing USER never
#      silently splits the cache anymore.
export PLANSYNC_BUILD_USER="${PLANSYNC_BUILD_USER:-${USER:-$(whoami)}}"
# Keep USER exported too so older tooling that still reads it sees
# the same resolved value.
export USER="$PLANSYNC_BUILD_USER"
BUILD_DIR="$PROJECT_DIR/packages/api/tmp/ps-next-build-$PLANSYNC_BUILD_USER"
# #286/#288: package-lock.json drives every transitive dep version Next
# bakes into the build (and SDK upgrades like @modelcontextprotocol/sdk
# change the bundle). Without including it, `npm install` of a new
# dep version reused the stale webpack cache and produced confusing
# "this works locally but not after deploy" failures.
NEXT_CACHE_INPUTS=(
  "$PROJECT_DIR/packages/api/next.config.js"
  "$PROJECT_DIR/packages/api/package.json"
  "$PROJECT_DIR/package-lock.json"
)
if should_clear_next_cache "$BUILD_DIR" "${NEXT_CACHE_INPUTS[@]}"; then
  echo "Clearing stale Next.js build cache (config changed)..."
  rm -rf "$BUILD_DIR"
fi
mkdir -p "$BUILD_DIR"
write_next_cache_marker "$BUILD_DIR" "${NEXT_CACHE_INPUTS[@]}"

# Ensure migrations are up to date
if [ ! -f "$PROJECT_DIR/node_modules/prisma/build/index.js" ]; then
  echo "Prisma CLI not found in local dependencies"
  echo "Run: ./bin/ps-admin start"
  exit 1
fi
run_local_prisma migrate deploy --schema "$PROJECT_DIR/packages/api/prisma/schema.prisma"
run_local_prisma generate --schema "$PROJECT_DIR/packages/api/prisma/schema.prisma"

# R-138: keep single-machine dev experience identical by running the heartbeat
# scanner in-process with the API. Multi-replica / serverless deployments must
# leave this unset and run `npm run --workspace=@plansync/api worker` in a
# dedicated process instead.
export PLANSYNC_RUN_WORKER_IN_API=true

exec "$LOCAL_NPM_BIN" run --workspace=@plansync/api dev -- --port "$PORT"
