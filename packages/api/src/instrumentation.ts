/**
 * R-138: gate the in-process heartbeat scanner behind an explicit env flag.
 *
 * Why: `instrumentation.ts` is loaded by every Next.js Node worker process.
 * Unconditionally starting the 60s setInterval here means:
 *   - multi-replica deployments wake every API instance every minute (work
 *     itself is de-duped by the R-056 advisory lock, but every replica still
 *     pays for the timer + DB round-trip);
 *   - serverless deployments don't work at all (the worker process is
 *     short-lived and the timer never gets to fire).
 *
 * The fix is to move the scanner into a dedicated worker entry
 * (`scripts/run-worker.ts`, run via `npm run --workspace=@plansync/api worker`)
 * and require operators to opt back in to the bundled-with-API behaviour by
 * setting `PLANSYNC_RUN_WORKER_IN_API=true`. The dev script (`scripts/dev.sh`)
 * sets that flag automatically so single-machine workflow is unchanged.
 *
 * Exported so the unit test can assert the gate without booting Next.
 */
export function shouldRunWorkerInApi(): boolean {
  return process.env.PLANSYNC_RUN_WORKER_IN_API === 'true';
}

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const fs = await import('fs');
    const path = await import('path');
    const cwd = process.cwd();
    const sourceSchema = path.join(cwd, 'prisma/schema.prisma');
    const generatedSchema = path.join(cwd, '../../node_modules/.prisma/client/schema.prisma');
    try {
      const srcMtime = fs.statSync(sourceSchema).mtimeMs;
      const genMtime = fs.statSync(generatedSchema).mtimeMs;
      if (srcMtime > genMtime) {
        console.error(
          '\n⚠ prisma/schema.prisma has changed since last `prisma generate`.\n' +
            '  Run: npx prisma generate   (or restart via ./scripts/dev.sh)\n',
        );
        process.exit(1);
      }
    } catch {
      // If either file is missing, skip the check
    }

    if (shouldRunWorkerInApi()) {
      const { startHeartbeatScanner } = await import('./lib/heartbeat-scanner');
      startHeartbeatScanner();
    } else {
      // #258 / #262 / #266 / #274: a default `next start` no longer runs
      // the heartbeat scanner. Operators upgrading past R-138 who deploy
      // the API but forget to deploy the worker get NO heartbeat detection
      // — runs that miss their heartbeat just sit in 'running' forever.
      // Log a one-time warning at boot so the regression is visible in
      // logs / `kubectl logs api`. Skip in test (vitest sets NODE_ENV=test)
      // and in build phases so we don't pollute every test / build run.
      const isProductionLike =
        (process.env.NODE_ENV === 'production' ||
          process.env.NEXT_PHASE === 'phase-production-runtime') &&
        process.env.NEXT_PHASE !== 'phase-production-build';
      if (isProductionLike) {
        const { logger } = await import('./lib/logger');
        logger.warn(
          {
            flag: 'PLANSYNC_RUN_WORKER_IN_API',
          },
          'PlanSync API is running WITHOUT the heartbeat scanner. ' +
            'Either deploy a separate worker process (npm run --workspace=@plansync/api worker) ' +
            'or set PLANSYNC_RUN_WORKER_IN_API=true. Otherwise stale ExecutionRuns will not be detected.',
        );
      }
    }

    // R-113 follow-up (#317 / #351): the sendMail queue lives in this
    // process's memory. A SIGTERM during a redeploy must drain it before
    // exit, otherwise pending notification emails are silently lost.
    // Hook idempotently — Next.js may load instrumentation.ts more than
    // once during dev (HMR), so guard with a process-level flag so we do
    // not register duplicate listeners.
    const procWithFlag = process as NodeJS.Process & { __plansyncMailFlush?: boolean };
    if (!procWithFlag.__plansyncMailFlush) {
      procWithFlag.__plansyncMailFlush = true;
      const { flushSendMailQueue, getPendingMailTotal } = await import('./lib/email');
      registerMailDrainOnExit({
        flushSendMailQueue,
        // P0-7 / closes #541-cls: aggregate (queue + inFlight + processing)
        // — the previous wiring read queue.length only, so a 5s drain
        // that timed out while a sendmail child was still running
        // misreported `pending=0` and exited with code 0, SIGKILL'ing
        // the in-flight child mid-write. getPendingMailTotal makes
        // the drain accurate.
        getPendingCount: getPendingMailTotal,
        onExit: (code) => process.exit(code),
        installSignalHandler: (signal, handler) => {
          process.on(signal, handler);
        },
      });
    }
  }
}

/**
 * Build + register the SIGTERM / SIGINT drain handler.
 *
 * Pulled out into a pure function so the unit test can inject fake
 * `flushSendMailQueue`, `onExit`, `getPendingCount`, and a synchronous
 * signal-handler installer, then assert the contract:
 *
 *   - the handler awaits `flushSendMailQueue()`
 *   - it bounds the wait at DRAIN_TIMEOUT_MS so a stuck sendmail does not
 *     block shutdown indefinitely
 *   - it logs whether the queue actually drained or the timeout fired
 *   - it calls `onExit(0)` when the drain is clean and `onExit(1)` when
 *     the timeout fired with messages still pending
 *   - duplicate signals (a frantic SIGTERM SIGTERM SIGTERM from an
 *     impatient orchestrator) do not re-enter the drain
 *
 * Reviewer-driven (#541 / #542 / #561 / #562 / #576 / #585 / #586 / #592 /
 * #599 / #608): the previous fire-and-forget Promise.race never awaited
 * the flush — Node would exit the moment the signal handler returned,
 * cancelling the in-flight sendmail children with SIGKILL.
 */
export interface MailDrainDeps {
  flushSendMailQueue: () => Promise<void>;
  getPendingCount: () => number;
  onExit: (code: number) => void;
  installSignalHandler: (
    signal: 'SIGTERM' | 'SIGINT',
    handler: (signal: NodeJS.Signals) => void,
  ) => void;
  drainTimeoutMs?: number;
  logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}

const DEFAULT_DRAIN_TIMEOUT_MS = 5000;

export function registerMailDrainOnExit(deps: MailDrainDeps): void {
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const log = deps.logger ?? {
    info: (...a: unknown[]) => console.warn(...(a as [unknown, ...unknown[]])),
    warn: (...a: unknown[]) => console.warn(...(a as [unknown, ...unknown[]])),
  };
  let draining = false;

  async function drainOnExit(signal: NodeJS.Signals): Promise<void> {
    if (draining) {
      // A second SIGTERM during the drain — typical of supervisors that
      // escalate after a few seconds. Surface the warning but don't
      // stack another flush.
      log.warn(`[instrumentation] ${signal} received during drain; ignoring`);
      return;
    }
    draining = true;

    let timedOut = false;
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve('timeout');
      }, drainTimeoutMs),
    );

    try {
      await Promise.race([deps.flushSendMailQueue(), timeout]);
    } catch (err) {
      log.warn(
        `[instrumentation] mail flush threw during ${signal} drain: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const pending = deps.getPendingCount();
    if (timedOut && pending > 0) {
      log.warn(
        `[instrumentation] mail queue drain timed out on ${signal}; ${pending} message(s) lost (timeout=${drainTimeoutMs}ms)`,
      );
      deps.onExit(1);
      return;
    }
    log.info(`[instrumentation] mail queue drained on ${signal}`);
    deps.onExit(0);
  }

  deps.installSignalHandler('SIGTERM', (s) => {
    void drainOnExit(s);
  });
  deps.installSignalHandler('SIGINT', (s) => {
    void drainOnExit(s);
  });
}
