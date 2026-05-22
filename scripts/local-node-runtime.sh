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
PG_PORT=${PG_PORT:-15432}
PG_DATA="/tmp/plansync-pgdata-$(whoami)"

# Probe order for the PostgreSQL toolchain, most-specific-first.
# Each candidate is checked for an executable `pg_ctl`; the first hit wins.
# Override via the PG_BIN env var.
#
# - /tool/pandora64/bin           — AMD internal Pandora image
# - /usr/lib/postgresql/16/bin    — Debian / Ubuntu apt postgresql-16
# - /usr/lib/postgresql/15/bin    — Debian / Ubuntu apt postgresql-15 (fallback)
# - /usr/pgsql-16/bin             — Red Hat / Rocky / Fedora pgdg
# - /opt/homebrew/opt/postgresql@16/bin — macOS Apple Silicon Homebrew
# - /usr/local/opt/postgresql@16/bin    — macOS Intel Homebrew
# - /opt/local/lib/postgresql16/bin     — macOS MacPorts
# - PATH lookup (last resort, prevents false-positives in CI sandboxes).
PG_BIN_CANDIDATES_DEFAULT="/tool/pandora64/bin /usr/lib/postgresql/16/bin /usr/lib/postgresql/15/bin /usr/pgsql-16/bin /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin /opt/local/lib/postgresql16/bin"

# detect_pg_bin: print the first probe directory that contains a real
# `pg_ctl`, or the empty string if none does. Caller decides whether to
# treat empty as fatal.
#
# - Honours PG_BIN if it is non-empty AND points at an executable pg_ctl.
# - Otherwise probes PG_BIN_CANDIDATES (CSV / whitespace-separated) before
#   falling back to PG_BIN_CANDIDATES_DEFAULT.
# - Final fallback: PATH lookup via `command -v pg_ctl`.
# - Pure: writes nothing to stderr / stdout except the result. Make all
#   logging the caller's responsibility so unit tests can assert exit
#   code + stdout deterministically.
detect_pg_bin() {
  if [ -n "${PG_BIN:-}" ] && [ -x "$PG_BIN/pg_ctl" ]; then
    printf '%s' "$PG_BIN"
    return 0
  fi

  local candidates="${PG_BIN_CANDIDATES:-$PG_BIN_CANDIDATES_DEFAULT}"
  # Allow comma-separated lists for env-friendly overrides.
  candidates="${candidates//,/ }"

  local dir
  for dir in $candidates; do
    if [ -x "$dir/pg_ctl" ]; then
      printf '%s' "$dir"
      return 0
    fi
  done

  # PATH-based fallback only as a last resort: in unit tests the PATH is
  # cleared so this never accidentally picks up a host-installed Postgres
  # and causes a false-positive in failure-path tests. Use bash parameter
  # expansion (`%/*`) to strip the basename — `dirname` is itself an
  # external command and may not be reachable when PATH is restricted.
  local resolved
  resolved="$(command -v pg_ctl 2>/dev/null || true)"
  if [ -n "$resolved" ]; then
    printf '%s' "${resolved%/*}"
    return 0
  fi

  printf ''
  return 1
}

# Resolve PG_BIN once at source time so subsequent calls do not re-probe
# the filesystem on every script invocation. If detection fails, leave
# PG_BIN unset (rather than the previous behaviour of setting it to a
# bogus Debian-16 path that polluted PATH and broke pg_ctl invocations
# silently on macOS / Red Hat hosts).
if [ -z "${PG_BIN:-}" ]; then
  if _resolved_pg_bin="$(detect_pg_bin)" && [ -n "$_resolved_pg_bin" ]; then
    PG_BIN="$_resolved_pg_bin"
  else
    PG_BIN=""
  fi
  unset _resolved_pg_bin
fi

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

  # NFS-safe removal: retry up to 3 times for silly-rename lingering files
  local retries=3
  while [ "$retries" -gt 0 ] && [ -e "$LOCAL_NODE_DIR" ]; do
    rm -rf "$LOCAL_NODE_DIR" 2>/dev/null || true
    [ -e "$LOCAL_NODE_DIR" ] && sleep 1
    retries=$((retries - 1))
  done
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

  # Linux + most BSDs ship `ss`. macOS does not — use `lsof` as a fallback.
  # Returning 1 ('not in use') silently when no probe tool is available
  # would mean pg-start.sh thinks a free port is occupied and fails the
  # user with a confusing diagnostic — so use `lsof` here even though it
  # is slower; it is the standard tool on every supported platform.
  if command -v ss >/dev/null 2>&1; then
    local output
    output="$(ss -ltn "( sport = :$port )" 2>/dev/null || true)"
    [ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -gt 1 ]
    return $?
  fi

  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi

  # Last-resort: try /dev/tcp from bash. This will succeed iff something
  # is listening on the port — works on every Linux/macOS host with bash.
  if (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    return 0
  fi
  return 1
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

detect_python38() {
  # node-pty requires Python 3.8+ for its node-gyp build scripts.
  # Search common locations for a compatible Python interpreter.
  for py in python3.8 python3.9 python3.10 python3.11 python3.12 python3 python; do
    local py_path
    py_path="$(command -v "$py" 2>/dev/null)" || continue
    local ver
    ver="$("$py_path" -c 'import sys; print(sys.version_info.major * 10 + sys.version_info.minor)' 2>/dev/null)" || continue
    if [ "$ver" -ge 38 ]; then
      echo "$py_path"
      return 0
    fi
  done
  return 1
}

ensure_local_dependencies() {
  ensure_local_node_runtime

  if dependencies_need_install; then
    # If the server is already running, dependencies are clearly installed.
    # Skip npm install to avoid ETXTBSY when esbuild is held open by the server process.
    if is_plansync_api_reachable "$(plansync_api_url)"; then
      touch "$LOCAL_DEPS_STAMP"
      return 0
    fi
    log_step "Installing workspace dependencies"
    # node-pty (native addon) requires Python 3.8+ for node-gyp; detect and export it.
    local py38
    if py38="$(detect_python38)"; then
      export PYTHON="$py38"
    fi
    if ! run_local_npm install --prefix "$PROJECT_DIR" --cache "$LOCAL_NPM_CACHE"; then
      log_step "npm install failed; clearing cache and retrying"
      rm -rf "$LOCAL_NPM_CACHE"
      run_local_npm install --prefix "$PROJECT_DIR" --cache "$LOCAL_NPM_CACHE"
    fi
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

  if [ -z "${PG_BIN:-}" ]; then
    echo "✗ PostgreSQL toolchain not found. Tried PG_BIN, PG_BIN_CANDIDATES," >&2
    echo "  and the PATH. Install postgresql or set PG_BIN explicitly." >&2
    return 2
  fi
  # Prepend BOTH local node + PG_BIN to PATH. Skip an empty PG_BIN to
  # avoid producing PATH=...::... where the empty entry is interpreted by
  # bash as the current working directory.
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
  # Check for migration file drift (applied migrations whose SQL was edited after the fact).
  # prisma migrate status exits non-zero and prints "checksum mismatch" when this happens.
  if run_local_prisma migrate status --schema "$PROJECT_DIR/packages/api/prisma/schema.prisma" 2>&1 | grep -q "checksum"; then
    echo ""
    echo "⚠ WARNING: One or more applied migration files have been modified since they were"
    echo "  applied. This can cause schema drift between environments."
    echo "  Run: npx prisma migrate status   to see which migrations are affected."
    echo "  Fix: create a new migration to correct the drift — do NOT edit the existing file."
    echo ""
  fi
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

  # Non-owner: verify required files exist, skip all write operations.
  # The owner (admin) is responsible for setup via ps-admin start.
  if [ ! -w "$PROJECT_DIR" ]; then
    if ! local_node_runtime_exists; then
      echo "❌ Node.js runtime not found." >&2
      echo "   Ask the server admin to run: ps-admin start" >&2
      exit 1
    fi
    if [ ! -f "$PROJECT_DIR/packages/mcp-server/dist/index.js" ]; then
      echo "❌ MCP server not built." >&2
      echo "   Ask the server admin to run: ps-admin start" >&2
      exit 1
    fi
    use_local_node_runtime
    return 0
  fi

  # Owner: normal setup flow
  ensure_env_file
  ensure_local_dependencies
  ensure_mcp_server_build
}
