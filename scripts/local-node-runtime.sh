#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

PLANSYNC_NODE_VERSION="${PLANSYNC_NODE_VERSION:-22.14.0}"
LOCAL_RUNTIME_DIR="$PROJECT_DIR/.local-runtime"
LOCAL_NODE_DIR="$LOCAL_RUNTIME_DIR/node"
LOCAL_NODE_BIN="$LOCAL_NODE_DIR/bin/node"
LOCAL_NPM_BIN="$LOCAL_NODE_DIR/bin/npm"
LOCAL_NPX_BIN="$LOCAL_NODE_DIR/bin/npx"
LOCAL_NPM_CACHE="/tmp/npm-cache-$(whoami)"
LOCAL_CACHE_DIR="$PROJECT_DIR/.cache"
LOCAL_DEPS_STAMP="$LOCAL_CACHE_DIR/deps-installed.stamp"
PG_BIN="${PG_BIN:-/tool/pandora64/bin}"
PG_PORT=${PG_PORT:-15432}
PG_DATA="/tmp/plansync-pgdata-$(whoami)"

log_step() {
  echo "==> $*"
}

detect_local_node_platform() {
  case "$(uname -s)" in
    Linux) LOCAL_NODE_OS="linux" ;;
    Darwin) LOCAL_NODE_OS="darwin" ;;
    *)
      echo "Unsupported OS: $(uname -s)" >&2
      return 1
      ;;
  esac

  case "$(uname -m)" in
    x86_64 | amd64) LOCAL_NODE_ARCH="x64" ;;
    arm64 | aarch64) LOCAL_NODE_ARCH="arm64" ;;
    *)
      echo "Unsupported architecture: $(uname -m)" >&2
      return 1
      ;;
  esac

  LOCAL_NODE_DIST="node-v${PLANSYNC_NODE_VERSION}-${LOCAL_NODE_OS}-${LOCAL_NODE_ARCH}"
  LOCAL_NODE_ARCHIVE="${LOCAL_NODE_DIST}.tar.gz"
  LOCAL_NODE_URL="https://nodejs.org/dist/v${PLANSYNC_NODE_VERSION}/${LOCAL_NODE_ARCHIVE}"
}

download_local_node_archive() {
  local url="$1"
  local output_path="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$output_path"
    return 0
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -qO "$output_path" "$url"
    return 0
  fi

  echo "Neither curl nor wget is available; cannot download Node.js." >&2
  return 1
}

install_local_node_runtime() {
  detect_local_node_platform

  local tmp_dir
  local archive_path
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/plansync-node-XXXXXX")"
  archive_path="$tmp_dir/$LOCAL_NODE_ARCHIVE"

  rm -rf "$LOCAL_NODE_DIR"
  mkdir -p "$LOCAL_RUNTIME_DIR"

  log_step "Installing local Node.js runtime (v${PLANSYNC_NODE_VERSION})"
  download_local_node_archive "$LOCAL_NODE_URL" "$archive_path"

  tar -xzf "$archive_path" -C "$tmp_dir"
  mv "$tmp_dir/$LOCAL_NODE_DIST" "$LOCAL_NODE_DIR"
  rm -rf "$tmp_dir"
}

local_node_runtime_exists() {
  [ -x "$LOCAL_NODE_BIN" ] && [ -x "$LOCAL_NPM_BIN" ]
}

require_local_node_runtime() {
  if ! local_node_runtime_exists; then
    echo "Local Node runtime not found at $LOCAL_NODE_DIR" >&2
    echo "Run a PlanSync entrypoint first: ./bin/ps-admin start or ./bin/plansync --host cursor" >&2
    exit 1
  fi
}

ensure_local_node_runtime() {
  if ! local_node_runtime_exists; then
    install_local_node_runtime
  fi
  use_local_node_runtime
}

use_local_node_runtime() {
  export PATH="$LOCAL_NODE_DIR/bin:$PATH"
  export npm_config_cache="$LOCAL_NPM_CACHE"
  mkdir -p "$LOCAL_NPM_CACHE"
  mkdir -p "$LOCAL_CACHE_DIR"
}

run_local_node() {
  "$LOCAL_NODE_BIN" "$@"
}

run_local_npm() {
  "$LOCAL_NPM_BIN" "$@"
}

run_local_npx() {
  "$LOCAL_NPX_BIN" "$@"
}

run_local_prisma() {
  run_local_node "$PROJECT_DIR/node_modules/prisma/build/index.js" "$@"
}

plansync_api_url() {
  local port="${1:-${PORT:-3001}}"
  echo "http://localhost:${port}"
}

api_healthcheck_url() {
  local base_url="$1"
  echo "${base_url%/}/api/health"
}

is_plansync_api_reachable() {
  local base_url="$1"
  curl -fsS --connect-timeout 2 "$(api_healthcheck_url "$base_url")" >/dev/null 2>&1
}

port_in_use() {
  local port="$1"

  if ! command -v ss >/dev/null 2>&1; then
    return 1
  fi

  local output
  output="$(ss -ltn "( sport = :$port )" 2>/dev/null || true)"
  [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -gt 1 ]
}

ensure_env_file() {
  if [ ! -f "$PROJECT_DIR/.env" ] && [ -f "$PROJECT_DIR/.env.example" ]; then
    cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  fi
}

dependencies_need_install() {
  if [ ! -d "$PROJECT_DIR/node_modules" ]; then
    return 0
  fi

  if [ ! -f "$PROJECT_DIR/node_modules/prisma/build/index.js" ]; then
    return 0
  fi

  if [ ! -f "$LOCAL_DEPS_STAMP" ]; then
    return 0
  fi

  if [ "$PROJECT_DIR/package-lock.json" -nt "$LOCAL_DEPS_STAMP" ]; then
    return 0
  fi

  return 1
}

ensure_local_dependencies() {
  ensure_local_node_runtime

  if dependencies_need_install; then
    log_step "Installing workspace dependencies"
    run_local_npm install --cache "$LOCAL_NPM_CACHE"
    touch "$LOCAL_DEPS_STAMP"
  fi
}

workspace_build_needed() {
  local package_dir="$1"
  local artifact_path="$2"

  if [ ! -e "$artifact_path" ]; then
    return 0
  fi

  if [ "$package_dir/package.json" -nt "$artifact_path" ]; then
    return 0
  fi

  if [ -d "$package_dir/src" ] && find "$package_dir/src" -type f -newer "$artifact_path" -print -quit | grep -q .; then
    return 0
  fi

  return 1
}

ensure_workspace_build() {
  local workspace_name="$1"
  local package_dir="$2"
  local artifact_path="$3"

  ensure_local_dependencies

  if workspace_build_needed "$package_dir" "$artifact_path"; then
    log_step "Building $workspace_name"
    run_local_npm run --workspace="$workspace_name" build
  fi
}

ensure_shared_build() {
  ensure_workspace_build "@plansync/shared" "$PROJECT_DIR/packages/shared" "$PROJECT_DIR/packages/shared/dist/index.js"
}

ensure_mcp_server_build() {
  ensure_shared_build
  ensure_workspace_build "@plansync/mcp-server" "$PROJECT_DIR/packages/mcp-server" "$PROJECT_DIR/packages/mcp-server/dist/index.js"
}

ensure_cli_build() {
  ensure_workspace_build "@plansync/cli" "$PROJECT_DIR/packages/cli" "$PROJECT_DIR/packages/cli/dist/index.js"
}

prisma_generate_needed() {
  local schema_path="$PROJECT_DIR/packages/api/prisma/schema.prisma"
  local client_artifact="$PROJECT_DIR/node_modules/.prisma/client/index.js"

  if [ ! -e "$client_artifact" ]; then
    return 0
  fi

  if [ "$schema_path" -nt "$client_artifact" ]; then
    return 0
  fi

  return 1
}

ensure_prisma_generated() {
  ensure_local_dependencies

  if prisma_generate_needed; then
    log_step "Generating Prisma client"
    run_local_prisma generate --schema "$PROJECT_DIR/packages/api/prisma/schema.prisma"
  fi
}

ensure_postgres_running() {
  local initialized_now=0

  export PATH="$LOCAL_NODE_DIR/bin:$PG_BIN:$PATH"

  if [ ! -d "$PG_DATA" ]; then
    log_step "Initializing PostgreSQL data directory"
    initdb -D "$PG_DATA" > /dev/null 2>&1
    initialized_now=1
  fi

  if ! pg_isready -p "$PG_PORT" -q 2>/dev/null; then
    log_step "Starting PostgreSQL on port $PG_PORT"
    pg_ctl -D "$PG_DATA" -l "$PG_DATA/logfile" -o "-p $PG_PORT" start > /dev/null 2>&1
  fi

  if createdb -p "$PG_PORT" plansync_dev 2>/dev/null; then
    log_step "Creating database plansync_dev"
    initialized_now=1
  fi

  return "$initialized_now"
}

ensure_owner_runtime_ready() {
  local fresh_db=1

  log_step "Checking owner runtime and server prerequisites"
  ensure_env_file
  ensure_local_dependencies
  ensure_shared_build
  ensure_mcp_server_build
  ensure_cli_build
  ensure_prisma_generated

  if ensure_postgres_running; then
    fresh_db=0
  fi

  log_step "Applying database migrations"
  run_local_prisma migrate deploy --schema "$PROJECT_DIR/packages/api/prisma/schema.prisma"
  OWNER_RUNTIME_FRESH_DB="$fresh_db"
}

seed_demo_if_requested() {
  if [ "${PLANSYNC_SEED_DEMO:-true}" != "true" ]; then
    return 0
  fi

  log_step "Seeding demo data"
  (
    cd "$PROJECT_DIR/packages/api"
    set -a
    . "$PROJECT_DIR/.env"
    set +a
    export PATH="$LOCAL_NODE_DIR/bin:$PATH"
    export npm_config_cache="$LOCAL_NPM_CACHE"
    run_local_prisma db seed --schema "$PROJECT_DIR/packages/api/prisma/schema.prisma"
  )
}

ensure_user_runtime_ready() {
  log_step "Checking user runtime and MCP prerequisites"
  ensure_env_file
  ensure_local_dependencies
  ensure_mcp_server_build
}
