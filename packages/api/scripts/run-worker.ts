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
import { startHeartbeatScanner, stopHeartbeatScanner } from '../src/lib/heartbeat-scanner';
import { logger } from '../src/lib/logger';

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
