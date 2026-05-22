import { describe, expect, it } from 'vitest';
import { shouldRunWorkerInApi } from '../../src/instrumentation';

describe('R-138 instrumentation gate (#258 / #262 / #266 / #274)', () => {
  const ORIG = process.env.PLANSYNC_RUN_WORKER_IN_API;

  it('returns true only for the literal string "true"', () => {
    process.env.PLANSYNC_RUN_WORKER_IN_API = 'true';
    expect(shouldRunWorkerInApi()).toBe(true);

    process.env.PLANSYNC_RUN_WORKER_IN_API = 'TRUE';
    expect(shouldRunWorkerInApi()).toBe(false);

    process.env.PLANSYNC_RUN_WORKER_IN_API = '1';
    expect(shouldRunWorkerInApi()).toBe(false);

    delete process.env.PLANSYNC_RUN_WORKER_IN_API;
    expect(shouldRunWorkerInApi()).toBe(false);

    if (ORIG !== undefined) process.env.PLANSYNC_RUN_WORKER_IN_API = ORIG;
  });
});
