import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMailDrainOnExit } from '../../src/instrumentation';

/**
 * Closes #541 / #542 / #561 / #562 / #576 / #585 / #586 / #592 / #599 / #608.
 *
 * `registerMailDrainOnExit` is the SIGTERM/SIGINT drain hook for the
 * sendMail queue (R-113). Reviewers found four real issues with the
 * fire-and-forget Promise.race form that landed in PR #486:
 *
 *   1. it did not await the flush, so Node exited the moment the
 *      handler returned and the in-flight sendmail children were
 *      SIGKILLed.
 *   2. it always called `console.warn('mail queue drained on ...')`
 *      regardless of whether the drain was clean or the timeout fired.
 *   3. it never called `process.exit()`, leaving the process alive.
 *   4. duplicate signals re-entered the drain.
 *
 * These tests inject fake deps so the contract can be asserted without
 * actually killing the test process.
 */
describe('registerMailDrainOnExit (#541 / #542 / #561 / #562 / #576 / #585 / #586 / #592 / #599 / #608)', () => {
  type Handler = (signal: NodeJS.Signals) => void;
  let handlers: Map<'SIGTERM' | 'SIGINT', Handler>;
  let fakeLogger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  let onExit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers = new Map();
    fakeLogger = { info: vi.fn(), warn: vi.fn() };
    onExit = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(opts: {
    flushDelayMs?: number;
    pendingAfterDrain?: number;
    drainTimeoutMs?: number;
    flushThrows?: Error;
  }) {
    const flushSendMailQueue = vi.fn(async () => {
      if (opts.flushThrows) throw opts.flushThrows;
      if (opts.flushDelayMs && opts.flushDelayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.flushDelayMs));
      }
    });
    const getPendingCount = vi.fn(() => opts.pendingAfterDrain ?? 0);
    registerMailDrainOnExit({
      flushSendMailQueue,
      getPendingCount,
      onExit,
      installSignalHandler: (signal, handler) => {
        handlers.set(signal, handler);
      },
      drainTimeoutMs: opts.drainTimeoutMs,
      logger: fakeLogger,
    });
    return { flushSendMailQueue, getPendingCount };
  }

  it('clean drain: awaits flush, logs info, exits with code 0', async () => {
    const { flushSendMailQueue } = setup({ pendingAfterDrain: 0 });

    expect(handlers.has('SIGTERM')).toBe(true);
    expect(handlers.has('SIGINT')).toBe(true);
    handlers.get('SIGTERM')!('SIGTERM');

    // Yield a few microtasks so the drain promise can run to completion.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(flushSendMailQueue).toHaveBeenCalledTimes(1);
    expect(fakeLogger.info).toHaveBeenCalledWith(expect.stringContaining('drained on SIGTERM'));
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('drain timeout with messages still pending: warns + exits with code 1', async () => {
    vi.useFakeTimers();
    const { flushSendMailQueue } = setup({
      flushDelayMs: 9999, // longer than drainTimeoutMs
      pendingAfterDrain: 7,
      drainTimeoutMs: 50,
    });

    handlers.get('SIGTERM')!('SIGTERM');

    await vi.advanceTimersByTimeAsync(60);
    // Yield to let the drain handler observe the timeout result.
    await Promise.resolve();
    await Promise.resolve();

    expect(flushSendMailQueue).toHaveBeenCalledTimes(1);
    const warnCalled = fakeLogger.warn.mock.calls.some(
      (c) =>
        String(c[0]).includes('drain timed out on SIGTERM') &&
        String(c[0]).includes('7 message(s) lost'),
    );
    expect(warnCalled).toBe(true);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('drain timeout but the queue actually emptied: still exits 0', async () => {
    // Edge: the flush takes longer than the timeout but by the time the
    // handler resumes, all messages did get out (e.g. the last one
    // finished while we were timing out). Treat empty pending as success.
    vi.useFakeTimers();
    setup({
      flushDelayMs: 9999,
      pendingAfterDrain: 0,
      drainTimeoutMs: 50,
    });

    handlers.get('SIGTERM')!('SIGTERM');
    await vi.advanceTimersByTimeAsync(60);
    await Promise.resolve();
    await Promise.resolve();

    expect(onExit).toHaveBeenCalledWith(0);
    expect(fakeLogger.info).toHaveBeenCalledWith(expect.stringContaining('drained on SIGTERM'));
  });

  it('flush throws: logs warn + still exits (does not hang)', async () => {
    setup({ flushThrows: new Error('boom'), pendingAfterDrain: 0 });

    handlers.get('SIGTERM')!('SIGTERM');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const warned = fakeLogger.warn.mock.calls.some((c) =>
      String(c[0]).includes('mail flush threw during SIGTERM drain'),
    );
    expect(warned).toBe(true);
    expect(onExit).toHaveBeenCalled();
  });

  it('duplicate SIGTERM during drain is ignored, not re-entered', async () => {
    vi.useFakeTimers();
    const { flushSendMailQueue } = setup({ flushDelayMs: 200, pendingAfterDrain: 0 });

    handlers.get('SIGTERM')!('SIGTERM');
    handlers.get('SIGTERM')!('SIGTERM');
    handlers.get('SIGTERM')!('SIGTERM');

    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();

    // Only the first signal triggers a flush; subsequent ones land on
    // the warn branch.
    expect(flushSendMailQueue).toHaveBeenCalledTimes(1);
    const ignored = fakeLogger.warn.mock.calls.filter((c) =>
      String(c[0]).includes('SIGTERM received during drain; ignoring'),
    );
    // 2 duplicates after the initial signal.
    expect(ignored.length).toBe(2);
  });

  it('SIGINT path mirrors SIGTERM (separate listeners installed)', async () => {
    setup({ pendingAfterDrain: 0 });
    expect(handlers.has('SIGINT')).toBe(true);
    handlers.get('SIGINT')!('SIGINT');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(fakeLogger.info).toHaveBeenCalledWith(expect.stringContaining('drained on SIGINT'));
    expect(onExit).toHaveBeenCalledWith(0);
  });
});
