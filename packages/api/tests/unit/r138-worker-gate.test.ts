/**
 * R-138: ensure the heartbeat scanner is no longer started unconditionally
 * inside the Next.js API process.
 *
 * The contract under test is:
 *   - `shouldRunWorkerInApi()` reads `process.env.PLANSYNC_RUN_WORKER_IN_API`
 *     on every call and returns true *only* for the exact string `'true'`.
 *     Anything else (unset, '1', 'TRUE', 'false', empty) returns false. This
 *     is load-bearing: ops should never accidentally re-enable the in-API
 *     timer because of a casing slip or "truthy-ish" value.
 *   - `register()` only calls `startHeartbeatScanner()` when both
 *       (a) NEXT_RUNTIME=nodejs (preserved from before R-138), and
 *       (b) PLANSYNC_RUN_WORKER_IN_API=true (the new gate).
 *     Anywhere else (Edge runtime, default API process, serverless cold start
 *     etc.) the scanner stays dormant and ops is expected to run
 *     `npm run --workspace=@plansync/api worker` in a dedicated process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const startSpy = vi.hoisted(() => vi.fn());
const stopSpy = vi.hoisted(() => vi.fn());

vi.mock('@/lib/heartbeat-scanner', () => ({
  startHeartbeatScanner: startSpy,
  stopHeartbeatScanner: stopSpy,
  scanStaleExecutions: vi.fn(),
}));

const ORIGINAL_FLAG = process.env.PLANSYNC_RUN_WORKER_IN_API;
const ORIGINAL_RUNTIME = process.env.NEXT_RUNTIME;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PLANSYNC_RUN_WORKER_IN_API;
  delete process.env.NEXT_RUNTIME;
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.PLANSYNC_RUN_WORKER_IN_API;
  else process.env.PLANSYNC_RUN_WORKER_IN_API = ORIGINAL_FLAG;
  if (ORIGINAL_RUNTIME === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = ORIGINAL_RUNTIME;
});

describe('R-138: heartbeat scanner is gated out of the Next API process by default', () => {
  it('shouldRunWorkerInApi() returns false when the env flag is unset', async () => {
    const { shouldRunWorkerInApi } = await import('@/instrumentation');
    expect(shouldRunWorkerInApi()).toBe(false);
  });

  it('shouldRunWorkerInApi() returns true only for the exact string "true"', async () => {
    const { shouldRunWorkerInApi } = await import('@/instrumentation');

    process.env.PLANSYNC_RUN_WORKER_IN_API = 'true';
    expect(shouldRunWorkerInApi()).toBe(true);

    // Strict equality — guard against casing/typo accidents in ops configs.
    for (const truthyButWrong of ['TRUE', 'True', '1', 'yes', 'on', '']) {
      process.env.PLANSYNC_RUN_WORKER_IN_API = truthyButWrong;
      expect(shouldRunWorkerInApi()).toBe(false);
    }

    process.env.PLANSYNC_RUN_WORKER_IN_API = 'false';
    expect(shouldRunWorkerInApi()).toBe(false);
  });

  it('register() does NOT start the scanner when the env flag is unset (default API process)', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    const { register } = await import('@/instrumentation');
    await register();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('register() starts the scanner when PLANSYNC_RUN_WORKER_IN_API=true (dev / single-machine opt-in)', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    process.env.PLANSYNC_RUN_WORKER_IN_API = 'true';
    const { register } = await import('@/instrumentation');
    await register();
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('register() never starts the scanner outside the Node runtime even when the flag is on', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    process.env.PLANSYNC_RUN_WORKER_IN_API = 'true';
    const { register } = await import('@/instrumentation');
    await register();
    expect(startSpy).not.toHaveBeenCalled();
  });
});
