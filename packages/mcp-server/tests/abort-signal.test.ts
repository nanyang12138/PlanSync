/**
 * Coverage for the process-wide run-abort signal (drift v2 S6).
 *
 * The signal is intentionally a one-shot latch: the moment the API tells
 * the heartbeat that the run is paused / stale / race-lost, the agent
 * should stop and a fresh process is required to resume. We pin:
 *   - idempotency (first abort wins; later calls do not re-fire listeners)
 *   - listener fan-out (every subscriber sees the first abort exactly once)
 *   - late subscribers get the latched state immediately (so a listener
 *     registered after the abort doesn't silently miss it)
 *   - one listener throwing does not block the others
 *   - isRunAborted reflects the latched reason
 *   - the test-only reset helper actually clears state between tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  signalRunAborted,
  isRunAborted,
  onRunAborted,
  _resetRunAbortedForTests,
} from '../src/abort-signal';

beforeEach(() => {
  _resetRunAbortedForTests();
});

describe('signalRunAborted — first abort wins, listeners fan out', () => {
  it('starts un-aborted', () => {
    expect(isRunAborted()).toBeNull();
  });

  it('latches the reason and isRunAborted returns it', () => {
    signalRunAborted({ code: 'RUN_PAUSED', message: 'paused', runId: 'r1', taskId: 't1' });
    expect(isRunAborted()).toEqual(
      expect.objectContaining({ code: 'RUN_PAUSED', runId: 'r1', taskId: 't1' }),
    );
  });

  it('every registered listener sees the first abort exactly once', () => {
    const a = vi.fn();
    const b = vi.fn();
    onRunAborted(a);
    onRunAborted(b);
    signalRunAborted({ code: 'RUN_PAUSED', message: 'x' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0][0].code).toBe('RUN_PAUSED');
  });

  it('a second abort call is ignored — listeners do NOT fire again', () => {
    const fn = vi.fn();
    onRunAborted(fn);
    signalRunAborted({ code: 'RUN_PAUSED', message: 'first' });
    signalRunAborted({ code: 'RUN_STALE_VERSION', message: 'second' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isRunAborted()?.code).toBe('RUN_PAUSED'); // first wins
  });

  it('one listener throwing does not prevent later listeners from firing', () => {
    const a = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const b = vi.fn();
    onRunAborted(a);
    onRunAborted(b);
    signalRunAborted({ code: 'RUN_PAUSED', message: 'x' });
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });
});

describe('onRunAborted — late subscribers', () => {
  it('a listener registered AFTER the abort still receives the reason (async)', async () => {
    signalRunAborted({ code: 'RUN_STALE_VERSION', message: 'too late?' });
    const fn = vi.fn();
    onRunAborted(fn);
    // Listener fires on the microtask queue so the caller cannot mistake it
    // for synchronous behaviour. Await one round-trip.
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].code).toBe('RUN_STALE_VERSION');
  });

  it('unsubscribe before the abort prevents the listener from firing', () => {
    const fn = vi.fn();
    const off = onRunAborted(fn);
    off();
    signalRunAborted({ code: 'RUN_PAUSED', message: 'x' });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('test-only reset helper', () => {
  it('clears the latched state so each test can start clean', () => {
    signalRunAborted({ code: 'MANUAL', message: 'reset me' });
    expect(isRunAborted()).not.toBeNull();
    _resetRunAbortedForTests();
    expect(isRunAborted()).toBeNull();
  });

  it('clears registered listeners too', () => {
    const fn = vi.fn();
    onRunAborted(fn);
    _resetRunAbortedForTests();
    signalRunAborted({ code: 'RUN_PAUSED', message: 'after-reset' });
    expect(fn).not.toHaveBeenCalled();
  });
});
