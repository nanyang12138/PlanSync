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
        process.env.NODE_ENV === 'production' ||
        process.env.NEXT_PHASE === 'phase-production-runtime';
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
      const { flushSendMailQueue } = await import('./lib/email');
      const drainOnExit = (signal: NodeJS.Signals) => {
        // Best-effort: 5s budget so a stuck sendmail does not block
        // shutdown indefinitely. We log + exit rather than awaiting
        // forever.
        const DRAIN_TIMEOUT_MS = 5000;
        Promise.race([
          flushSendMailQueue(),
          new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
        ]).finally(() => {
          console.warn(`[instrumentation] mail queue drained on ${signal}`);
        });
      };
      process.on('SIGTERM', () => drainOnExit('SIGTERM'));
      process.on('SIGINT', () => drainOnExit('SIGINT'));
    }
  }
}
