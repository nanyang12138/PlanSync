/**
 * R-138: dedicated background-worker entry point.
 *
 * Historically `instrumentation.ts` started the heartbeat scanner inside every
 * Next.js Node worker process. That:
 *   - wastes resources on multi-replica deployments (advisory lock keeps work
 *     correct, but the 60s timer still wakes every process);
 *   - breaks serverless deployments outright, where the API process is short-
 *     lived and a long-running timer simply never gets a chance to fire.
 *
 * This script is the explicit worker entry that ops / process supervisors
 * (systemd, supervisord, Kubernetes Deployment, etc.) should run alongside —
 * but separate from — the Next.js API process. The API process should NOT
 * start the scanner unless `PLANSYNC_RUN_WORKER_IN_API=true` is set
 * (preserved for single-machine dev/install convenience and exercised by
 * `scripts/dev.sh`).
 *
 * Usage:
 *   npm run --workspace=@plansync/api worker
 *
 * Lifecycle:
 *   - Starts the heartbeat scanner immediately.
 *   - On SIGTERM/SIGINT, stops the scanner and exits cleanly so process
 *     supervisors get a fast shutdown and don't have to SIGKILL.
 */
// #231: load .env from the repo root before importing any module that reads
// process.env at module-load time (logger, prisma, heartbeat-scanner).
// Bare `npm run --workspace=@plansync/api worker` previously exited because
// DATABASE_URL was unset — operators had to set -a / source .env / etc. by
// hand. This dotenv preamble removes that footgun while keeping
// already-exported env vars authoritative (env wins over file).
import path from 'node:path';
import fs from 'node:fs';

(function loadDotenv() {
  // packages/api/scripts -> ../../.. = repo root.
  const rootEnv = path.resolve(__dirname, '../../../.env');
  if (!fs.existsSync(rootEnv)) return;
  for (const line of fs.readFileSync(rootEnv, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    let value = m[2];
    // Strip surrounding quotes; do not interpret escapes (matches bash `set -a`).
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
})();

// #259: validate DATABASE_URL synchronously before importing anything that
// will try to use it. Without this, a misconfigured worker stays alive
// forever, only logs an error every 60s when the scanner runs, and gets
// reported as "healthy" by liveness probes that just check process state.
if (!process.env.DATABASE_URL) {
  console.error(
    'PlanSync worker: DATABASE_URL is not set. Refusing to start — the heartbeat scanner cannot run without a Postgres connection. Source .env or export DATABASE_URL before invoking the worker.',
  );
  process.exit(2);
}

// The worker runs under ts-node with `module: commonjs`; defer the
// scanner / logger imports until AFTER dotenv + DATABASE_URL check so the
// modules see the resolved env when their top-level code reads it.
//
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { startHeartbeatScanner, stopHeartbeatScanner } =
  require('../src/lib/heartbeat-scanner') as typeof import('../src/lib/heartbeat-scanner');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { logger } = require('../src/lib/logger') as typeof import('../src/lib/logger');

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'PlanSync worker: shutting down');
  stopHeartbeatScanner();
  // Give in-flight scan a beat to settle; the scanner itself does not hold
  // long-lived connections (each scan is a single short transaction), so
  // 200ms is more than enough for a clean exit on any healthy system.
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

logger.info('PlanSync worker: starting heartbeat scanner');
startHeartbeatScanner();
