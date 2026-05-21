/**
 * Heartbeat behaviour when the API rejects with drift-v2 codes (S6).
 *
 * The HeartbeatManager runs on a setInterval cadence; for the test we drive
 * it via the public start() method and a fake-timer tick, then assert that
 * an API error carrying details.code='RUN_PAUSED' / 'RUN_STALE_VERSION' /
 * 'RUN_RACE_LOST' latches the global abort signal AND stops the heartbeat,
 * while an unrelated API failure (network, generic 5xx) does NOT abort.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError } from '../src/api-client';
import { heartbeatManager } from '../src/tools/execution';
import { isRunAborted, _resetRunAbortedForTests } from '../src/abort-signal';

function makeApi(error: unknown) {
  return {
    post: vi.fn().mockRejectedValue(error),
    get: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    withUser: vi.fn(),
  } as unknown as import('../src/api-client').ApiClient;
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetRunAbortedForTests();
});

afterEach(() => {
  heartbeatManager.stopAll();
  vi.useRealTimers();
});

describe('HeartbeatManager — drift v2 abort detection', () => {
  it('RUN_PAUSED 409 latches the abort signal AND stops the heartbeat', async () => {
    const api = makeApi(
      new ApiError('Run paused', 'STATE_CONFLICT', 409, {
        code: 'RUN_PAUSED',
        runStatus: 'paused',
      }),
    );

    heartbeatManager.start('run-1', 'p1', 't1', api);
    await vi.advanceTimersByTimeAsync(30_000);
    // allow microtasks to flush so the async error handler completes
    await Promise.resolve();
    await Promise.resolve();

    expect(isRunAborted()?.code).toBe('RUN_PAUSED');
    expect(isRunAborted()?.runId).toBe('run-1');
    expect(isRunAborted()?.taskId).toBe('t1');
    expect(api.post).toHaveBeenCalledTimes(1);

    // After the abort fires, the heartbeat must have been stopped: advancing
    // another full interval must NOT issue another POST.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('RUN_STALE_VERSION 409 latches with the version details carried through', async () => {
    const api = makeApi(
      new ApiError('Run stale', 'STATE_CONFLICT', 409, {
        code: 'RUN_STALE_VERSION',
        runBoundPlanVersion: 1,
        taskBoundPlanVersion: 2,
      }),
    );
    heartbeatManager.start('run-2', 'p1', 't1', api);
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();
    const r = isRunAborted();
    expect(r?.code).toBe('RUN_STALE_VERSION');
    expect(r?.runBoundPlanVersion).toBe(1);
    expect(r?.taskBoundPlanVersion).toBe(2);
  });

  it('RUN_RACE_LOST 409 latches as code=RUN_RACE_LOST', async () => {
    const api = makeApi(
      new ApiError('Run race lost', 'STATE_CONFLICT', 409, { code: 'RUN_RACE_LOST' }),
    );
    heartbeatManager.start('run-3', 'p1', 't1', api);
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(isRunAborted()?.code).toBe('RUN_RACE_LOST');
  });

  it('generic 500 error does NOT latch the abort signal (transient failures stay transient)', async () => {
    const api = makeApi(new ApiError('Internal', 'INTERNAL', 500, undefined));
    heartbeatManager.start('run-4', 'p1', 't1', api);
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(isRunAborted()).toBeNull();
    // Heartbeat is NOT stopped on a generic failure — it'll retry next interval.
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it('plain network error (non-ApiError) does NOT latch the abort signal', async () => {
    const api = makeApi(new Error('ECONNRESET'));
    heartbeatManager.start('run-5', 'p1', 't1', api);
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(isRunAborted()).toBeNull();
  });
});
