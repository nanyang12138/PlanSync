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
    }
  }
}
