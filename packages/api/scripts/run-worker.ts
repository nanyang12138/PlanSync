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
// DATABASE_URL was unset — operators had to set -a / source .env / etc.
// by hand. The shared loader in load-dotenv.ts keeps already-exported env
// vars authoritative (env > .env). Idempotent — when worker-env-setup.ts
// already loaded .env via --require, this re-load is a fast no-op.
import { loadRepoDotenv } from './load-dotenv';
loadRepoDotenv();

// #259: validate DATABASE_URL synchronously before importing anything
// that will try to use it. Without this, a misconfigured worker stays
// alive forever, only logs an error every 60s when the scanner runs,
// and gets reported as "healthy" by liveness probes that just check
// process state.
//
// Five failure modes the truthy check missed (closes #571-class +
// R1/R1b round-2 review #934 #935 #942 #952 #1003 #1004 #990 #991):
//   1. Empty / whitespace-only DATABASE_URL.
//   2. DATABASE_URL with an unresolved `${USER}` / `${PG_PORT}` ref
//      (the curly form is unambiguously bash-template syntax).
//   3. DATABASE_URL that does not start with `postgresql://` /
//      `postgres://` (any scheme Prisma can't speak).
//   4. DATABASE_URL that has the right scheme but no host segment
//      (e.g. `postgresql://`, `postgresql:///plansync_dev`) — the
//      original truthy-only check accepted these and the connection
//      attempt failed minutes later.
//   5. DATABASE_URL the WHATWG URL parser rejects entirely.
//
// Failure messages route through redactDbUrl() so an operator with
// inline credentials (`postgresql://user:pass@host/db`) doesn't
// see them echoed to stderr or pino logs.
const PG_URL_RE = /^postgres(?:ql)?:\/\/([^/?#]*)/;

function redactDbUrl(raw: string): string {
  // R1b / closes #1003 #990 — pre-fix, when raw didn't match the
  // postgres URL shape, the redactor returned the first 16 chars
  // verbatim. A URL like `mysql://user:pass@…` therefore leaked
  // user:pass before failing the scheme check. Now we always
  // strip everything before the host: parse via the WHATWG URL
  // class and emit `<scheme>://***@<host>:<port>/…` regardless
  // of scheme; if even WHATWG fails to parse, fall back to a
  // scheme-free placeholder — never any chars from the credentials
  // segment.
  //
  // Closes #1046 — WHATWG `new URL()` happily parses
  // `alice:s3cret@db/x` (no `://` at all) as a "non-special URL"
  // with `protocol === 'alice:'` and `hostname === ''`. The pre-fix
  // success branch would then emit `alice://***@?/…`, leaking the
  // first colon-separated token from the input — which for any
  // accidentally-pasted `user:pass@host` shape IS the username.
  // The same trap caught the catch fallback's `${raw.slice(0,colon)}`,
  // so both paths needed tightening.
  //
  // Hard rule now: only echo the parsed protocol back if the raw
  // input actually contained `://`. Otherwise we have no idea
  // whether the leading token is a scheme or a username, and the
  // safe move is to drop it entirely.
  if (!raw.includes('://')) {
    return '[unparseable]';
  }
  try {
    const u = new URL(raw);
    const port = u.port ? `:${u.port}` : '';
    return `${u.protocol}//***@${u.hostname || '?'}${port}/…`;
  } catch {
    // We know `://` is in there but WHATWG still rejected it
    // (e.g. unbalanced IPv6 brackets, empty authority). Echo only
    // the part BEFORE the first `://` — that's safe because by
    // construction it cannot contain credentials.
    const sep = raw.indexOf('://');
    return `${raw.slice(0, sep)}://[unparseable]`;
  }
}

function validateDatabaseUrl(raw: string | undefined): string | null {
  if (!raw) return 'DATABASE_URL is not set';
  const trimmed = raw.trim();
  if (!trimmed) return 'DATABASE_URL is empty / whitespace-only';
  // Curly `${VAR}` is unambiguously template syntax. We deliberately
  // do NOT flag bare `$VAR` — by the time we run, dotenv + bash have
  // already done their thing; any remaining `$VAR` is data
  // (passwords, secrets), not a template (closes #935 #942 #952).
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(trimmed)) {
    return `DATABASE_URL contains unresolved \${VAR} template; redacted=${redactDbUrl(trimmed)}`;
  }
  if (!trimmed.startsWith('postgresql://') && !trimmed.startsWith('postgres://')) {
    return `DATABASE_URL must start with 'postgresql://' (redacted=${redactDbUrl(trimmed)})`;
  }
  // R1b / closes #1004 — a scheme-prefix-only check accepts
  // `postgresql:///plansync_dev` (no host). Reject when the
  // authority section between `//` and the next `/` is empty,
  // and confirm WHATWG can parse it as a URL with a hostname.
  const hostMatch = trimmed.match(PG_URL_RE);
  if (!hostMatch || !hostMatch[1] || hostMatch[1].split('@').pop() === '') {
    return `DATABASE_URL has empty host (redacted=${redactDbUrl(trimmed)})`;
  }
  try {
    const u = new URL(trimmed);
    if (!u.hostname) {
      return `DATABASE_URL has empty hostname (redacted=${redactDbUrl(trimmed)})`;
    }
  } catch {
    return `DATABASE_URL is not a parsable URL (redacted=${redactDbUrl(trimmed)})`;
  }
  return null;
}

const dbUrlError = validateDatabaseUrl(process.env.DATABASE_URL);
if (dbUrlError) {
  console.error(
    `PlanSync worker: ${dbUrlError}. Refusing to start — the heartbeat scanner ` +
      `cannot run without a valid Postgres connection. Source .env or export ` +
      `DATABASE_URL=postgresql://… before invoking the worker.`,
  );
  process.exit(2);
}

// The worker runs under ts-node with `module: commonjs`; defer the
// scanner / logger imports until AFTER dotenv + DATABASE_URL check so the
// modules see the resolved env when their top-level code reads it.
/* eslint-disable @typescript-eslint/no-require-imports */
const heartbeatModule =
  require('../src/lib/heartbeat-scanner') as typeof import('../src/lib/heartbeat-scanner');
const { startHeartbeatScanner, stopHeartbeatScanner } = heartbeatModule;
// R-139: the same dedicated worker process owns the persistent webhook
// retry queue. The worker is a no-op until `PLANSYNC_WEBHOOK_QUEUE=true`
// (it logs why on startup), so wiring it in unconditionally here is
// safe for deployments that haven't opted into the queue yet.
const webhookWorkerModule =
  require('../src/lib/webhook-worker') as typeof import('../src/lib/webhook-worker');
const { startWebhookWorker, stopWebhookWorker } = webhookWorkerModule;
const loggerModule = require('../src/lib/logger') as typeof import('../src/lib/logger');
const { logger } = loggerModule;
/* eslint-enable @typescript-eslint/no-require-imports */

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'PlanSync worker: shutting down');
  stopHeartbeatScanner();
  stopWebhookWorker();
  // Give in-flight scan a beat to settle; the scanner itself does not hold
  // long-lived connections (each scan is a single short transaction), so
  // 200ms is more than enough for a clean exit on any healthy system.
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

logger.info('PlanSync worker: starting heartbeat scanner');
startHeartbeatScanner();
logger.info('PlanSync worker: starting webhook queue worker (R-139)');
startWebhookWorker();
