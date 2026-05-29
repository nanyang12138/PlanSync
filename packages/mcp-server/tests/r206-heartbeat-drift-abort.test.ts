/**
 * R-206: heartbeat 200 responses that carry non-empty `driftAlerts` must
 * latch the abort signal AND stop the heartbeat interval.
 *
 * Why: the API filters LOW severity (runs/[runId]/route.ts:135 after
 * R-206), so anything the client sees here is HIGH or MEDIUM and means
 * the agent is on a gated task that for some reason was NOT auto-paused
 * — i.e. the activate↔start race window. Pre-R-206, `makeDriftCallback`
 * only emitted a `sendLoggingMessage` (rendered as chat in Claude Code,
 * does NOT trigger any interrupt), so the agent silently continued and
 * the next tool call passed through `tool-wrapper.ts:201`. The R-206
 * patch in `heartbeatManager.start` converts the soft signal into the
 * same `signalRunAborted({code:'RUN_PAUSED'})` the 409 path already
 * uses, so the next tool call short-circuits.
 *
 * Sibling test `heartbeat-abort.test.ts` covers the 409 paths
 * (RUN_PAUSED / RUN_STALE_VERSION / RUN_RACE_LOST); this file covers
 * the new 200-with-drift path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { heartbeatManager } from '../src/tools/execution';
import { isRunAborted, _resetRunAbortedForTests } from '../src/abort-signal';

type DriftAlert = { id: string; severity: string; reason: string };

function makeApiOk(driftAlerts: DriftAlert[]) {
  return {
    post: vi.fn().mockResolvedValue({ data: { driftAlerts } }),
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

describe('R-206: heartbeat 200-with-drift latches abort + stops interval', () => {
  it('non-empty driftAlerts (HIGH) → signalRunAborted called and heartbeat stops', async () => {
    const onDrift = vi.fn();
    const api = makeApiOk([{ id: 'd1', severity: 'high', reason: 'plan changed' }]);

    heartbeatManager.start('run-r206-1', 'p1', 't1', api, onDrift);
    await vi.advanceTimersByTimeAsync(30_000);
    // flush microtasks so the async heartbeat handler finishes
    await Promise.resolve();
    await Promise.resolve();

    const abort = isRunAborted();
    expect(abort?.code).toBe('RUN_PAUSED');
    expect(abort?.runId).toBe('run-r206-1');
    expect(abort?.taskId).toBe('t1');
    expect(abort?.message).toMatch(/Drift detected/);

    // onDrift is still called (for visibility / logging) AFTER the abort
    // is latched, so MCP clients that want to render the alert can.
    expect(onDrift).toHaveBeenCalledWith([{ id: 'd1', severity: 'high', reason: 'plan changed' }]);

    // Heartbeat must have been stopped — another full interval must not
    // issue a second POST.
    expect(api.post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('non-empty driftAlerts (MEDIUM) also latches abort (gate-agnostic)', async () => {
    const api = makeApiOk([{ id: 'd2', severity: 'medium', reason: 'refUri shifted' }]);

    heartbeatManager.start('run-r206-2', 'p1', 't1', api);
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(isRunAborted()?.code).toBe('RUN_PAUSED');
  });

  it('empty driftAlerts → no abort, heartbeat continues firing', async () => {
    const api = makeApiOk([]);

    heartbeatManager.start('run-r206-3', 'p1', 't1', api);
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();

    expect(isRunAborted()).toBeNull();

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it('missing driftAlerts field (older API) → no abort, heartbeat continues', async () => {
    // Defensively: if the API somehow returns a payload without the
    // driftAlerts key at all (legacy / mocked client / future schema
    // shift), we must not crash and must not abort.
    const api = {
      post: vi.fn().mockResolvedValue({ data: {} }),
      get: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      withUser: vi.fn(),
    } as unknown as import('../src/api-client').ApiClient;

    heartbeatManager.start('run-r206-4', 'p1', 't1', api);
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();

    expect(isRunAborted()).toBeNull();
  });
});
