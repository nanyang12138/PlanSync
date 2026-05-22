/**
 * R-071 — `/worker` Ctrl+C 中断子进程.
 *
 * The slash-command worker loop pauses raw input while polling, which means
 * a SIGINT handler hung off `rawInput.onSigint` never fires (no keypress
 * events flow while stdin is paused). The fix is to register a
 * process-level handler that:
 *
 *   1. Flips the worker's `stopWorker` flag so the polling loop exits after
 *      the current iteration.
 *   2. Forwards the signal to the live Genie child so the in-flight task
 *      is interrupted immediately rather than running to completion.
 *
 * Both pieces of behaviour live in the pure helper `createWorkerInterruptHandler`
 * so the test suite can exercise them without spawning Genie or mounting Ink.
 */

import { describe, it, expect, vi } from 'vitest';
import { createWorkerInterruptHandler } from '../src/worker-interrupt.js';

describe('R-071 — createWorkerInterruptHandler', () => {
  it('flips the stop flag and forwards SIGINT to the live child', () => {
    let stopped = false;
    const kill = vi.fn().mockReturnValue(true);
    const handler = createWorkerInterruptHandler({
      setStop: () => {
        stopped = true;
      },
      getChild: () => ({ kill }),
    });

    handler();

    expect(stopped).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('SIGINT');
  });

  it('still flips the stop flag when there is no active child', () => {
    let stopped = false;
    const handler = createWorkerInterruptHandler({
      setStop: () => {
        stopped = true;
      },
      getChild: () => null,
    });

    handler();

    expect(stopped).toBe(true);
  });

  it('swallows errors thrown by child.kill (child may already be dead)', () => {
    let stopped = false;
    const kill = vi.fn(() => {
      throw new Error('ESRCH');
    });
    const handler = createWorkerInterruptHandler({
      setStop: () => {
        stopped = true;
      },
      getChild: () => ({ kill }),
    });

    expect(() => handler()).not.toThrow();
    expect(stopped).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('logs the user-facing message when a logger is supplied', () => {
    const logger = vi.fn();
    const handler = createWorkerInterruptHandler({
      setStop: () => undefined,
      getChild: () => null,
      logger,
    });

    handler();

    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger.mock.calls[0][0]).toMatch(/Worker stopping after current task/i);
  });

  it('forwards the configured signal instead of SIGINT when overridden', () => {
    const kill = vi.fn().mockReturnValue(true);
    const handler = createWorkerInterruptHandler({
      setStop: () => undefined,
      getChild: () => ({ kill }),
      signal: 'SIGTERM',
    });

    handler();

    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('always calls setStop before signalling the child so the loop exits even if kill throws', () => {
    const order: string[] = [];
    const handler = createWorkerInterruptHandler({
      setStop: () => order.push('stop'),
      getChild: () => ({
        kill: () => {
          order.push('kill');
          throw new Error('boom');
        },
      }),
    });

    expect(() => handler()).not.toThrow();
    expect(order).toEqual(['stop', 'kill']);
  });
});
