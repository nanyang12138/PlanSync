import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// F4 / closes the deeper concern in P0-7 (#541-cls):
//   email.ts now uses `child_process.spawn` (async) instead of
//   `spawnSync` so the SIGTERM drain timer can actually fire while a
//   sendmail child is in flight. The test mock therefore needs to
//   simulate the async lifecycle: a Writable stdin, an EventEmitter
//   stderr, and `error` / `close` events on the child itself.
//
// We expose a `setNextChildBehaviour` helper so individual tests
// stay short — they describe a sequence of (exit code, stderr) for
// the next N spawn() invocations, then assert how many were
// consumed.

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Hoisted logger mock so the email module's structured-error path is
// observable in the test (#316 / #350 — the legacy console.warn was
// invisible to pino subscribers; the new code uses logger.error).
const { loggerWarn, loggerError } = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));
vi.mock('../../src/lib/logger', () => ({
  logger: {
    warn: loggerWarn,
    error: loggerError,
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { spawn } from 'child_process';
import {
  sendMail,
  flushSendMailQueueForTests,
  _sendMailQueueLengthForTests,
} from '../../src/lib/email';

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

interface ChildBehaviour {
  exitCode: number;
  stderr?: string;
  /** Total ms before close fires (default 0 → next tick). */
  delayMs?: number;
}

interface FakeStdin extends EventEmitter {
  write: (s: string) => boolean;
  end: () => void;
}

interface FakeChild extends EventEmitter {
  stdin: FakeStdin;
  stderr: EventEmitter;
  kill: (signal?: string) => boolean;
  /** Captured stdin payload so tests can inspect the rendered message. */
  receivedInput: string;
}

function makeFakeChild(b: ChildBehaviour): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.receivedInput = '';
  // R8: real `child.stdin` is a Writable, an EventEmitter — production
  // code now subscribes 'error' on it (closes #920 EPIPE handler), so
  // the fake must be an EventEmitter too.
  const stdin = new EventEmitter() as FakeStdin;
  stdin.write = (s: string) => {
    child.receivedInput += s;
    return true;
  };
  stdin.end = () => {
    const fire = () => {
      if (b.stderr) child.stderr.emit('data', Buffer.from(b.stderr));
      child.emit('close', b.exitCode);
    };
    if (b.delayMs && b.delayMs > 0) setTimeout(fire, b.delayMs);
    else setImmediate(fire);
  };
  child.stdin = stdin;
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

function ok(): ChildBehaviour {
  return { exitCode: 0 };
}

function fail(): ChildBehaviour {
  return { exitCode: 1, stderr: 'rejected' };
}

describe('R-113: sendMail asynchronous queue', () => {
  /** Per-test capture of the children we hand back so we can assert
   * call count + per-call rendered input. */
  let spawnedChildren: FakeChild[];

  beforeEach(() => {
    spawnedChildren = [];
    spawnMock.mockReset();
    loggerWarn.mockReset();
    loggerError.mockReset();
  });

  afterEach(async () => {
    await flushSendMailQueueForTests();
  });

  /** Configure spawn() to return a fixed sequence of behaviours; once
   * the sequence runs out, every subsequent call returns the LAST
   * behaviour (so a "succeed forever" test queues a single ok()). */
  function setSpawnSequence(seq: ChildBehaviour[]): void {
    let idx = 0;
    spawnMock.mockImplementation(() => {
      const beh = seq[Math.min(idx, seq.length - 1)] ?? ok();
      idx += 1;
      const child = makeFakeChild(beh);
      spawnedChildren.push(child);
      return child;
    });
  }

  it('returns synchronously without invoking sendmail in the same tick', async () => {
    setSpawnSequence([ok()]);

    const accepted = sendMail(['alice@example.com'], 'hi', 'body');

    expect(accepted).toBe(true);
    // spawn must NOT have been called synchronously — the queue worker
    // runs via setImmediate, so the request handler returns first.
    expect(spawnMock).not.toHaveBeenCalled();

    await flushSendMailQueueForTests();

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('drops messages with no deliverable recipients without queueing', async () => {
    setSpawnSequence([ok()]);

    const accepted = sendMail(['bob-demo-1776932148306@example.com'], 'hi', 'body');

    expect(accepted).toBe(false);
    expect(_sendMailQueueLengthForTests()).toBe(0);
    await flushSendMailQueueForTests();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('retries on transient sendmail failure (eventual success)', async () => {
    setSpawnSequence([fail(), ok()]);

    sendMail(['carol@example.com'], 'subj', 'body');
    await flushSendMailQueueForTests();

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after MAX_ATTEMPTS (3) and logs via logger.error (#316 / #350)', async () => {
    setSpawnSequence([fail()]);

    sendMail(['dave@example.com'], 'subj', 'body');
    await flushSendMailQueueForTests();

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(loggerError).toHaveBeenCalled();
    const errCall = loggerError.mock.calls.find(
      (c) => typeof c[1] === 'string' && /giving up/.test(c[1] as string),
    );
    expect(errCall, 'expected logger.error call mentioning "giving up"').toBeDefined();
    const ctx = errCall![0] as Record<string, unknown>;
    expect(ctx.attempts).toBe(3);
    expect(Array.isArray(ctx.to)).toBe(true);
    expect(ctx.subject).toBe('subj');
  });

  it('escapes header-injection attempts in the To/Subject fields', async () => {
    setSpawnSequence([ok()]);

    sendMail(['eve@example.com\nBcc: leaked@evil.com'], 'normal\r\nX-Injected: yes', 'body');
    await flushSendMailQueueForTests();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const message = spawnedChildren[0]!.receivedInput;
    expect(message).not.toMatch(/^Bcc:/m);
    expect(message).not.toMatch(/^X-Injected:/m);
  });

  // ---- #318 / #352: synchronous backpressure cap -------------------------

  it('#318/#352: rejects synchronously and logs warn when the queue is at the limit', async () => {
    setSpawnSequence([ok()]);

    let acceptedCount = 0;
    let rejectedCount = 0;
    for (let i = 0; i < 1001; i += 1) {
      const accepted = sendMail([`u${i}@example.com`], `s${i}`, 'b');
      if (accepted) acceptedCount += 1;
      else rejectedCount += 1;
    }
    expect(acceptedCount).toBe(1000);
    expect(rejectedCount).toBe(1);

    const warnCall = loggerWarn.mock.calls.find(
      (c) => typeof c[1] === 'string' && /queue full/i.test(c[1] as string),
    );
    expect(warnCall, 'expected logger.warn call mentioning "queue full"').toBeDefined();
    const ctx = warnCall![0] as Record<string, unknown>;
    expect(ctx.queueLength).toBe(1000);
    expect(ctx.limit).toBe(1000);

    await flushSendMailQueueForTests();
  });

  it('processes multiple queued messages in order', async () => {
    setSpawnSequence([ok()]);

    sendMail(['a@example.com'], 's1', 'b');
    sendMail(['b@example.com'], 's2', 'b');
    sendMail(['c@example.com'], 's3', 'b');

    expect(spawnMock).not.toHaveBeenCalled();

    await flushSendMailQueueForTests();

    expect(spawnMock).toHaveBeenCalledTimes(3);
    const subjects = spawnedChildren.map((child) => {
      const m = child.receivedInput.match(/^Subject: (.*)$/m);
      return m ? m[1] : '';
    });
    expect(subjects).toEqual(['s1', 's2', 's3']);
  });

  // F4 net-new: prove the drain does NOT block while a sendmail child
  // is in flight. Under the old spawnSync impl this test would have
  // hung the entire event loop for delayMs.
  it('F4: in-flight delivery does not block the event loop (async spawn)', async () => {
    setSpawnSequence([{ exitCode: 0, delayMs: 30 }]);

    sendMail(['slow@example.com'], 's', 'b');

    // Schedule a microtask BEFORE the close event would fire. Under
    // spawnSync this microtask would never run until close completed
    // because spawnSync owned the JS thread. Under spawn it runs
    // immediately.
    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 5);

    // Yield so the timer has a chance to land.
    await new Promise((r) => setTimeout(r, 10));
    expect(timerFired).toBe(true);

    await flushSendMailQueueForTests();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

// R8 / closes #920 — child.stdin EPIPE / ECONNRESET is async-emitted
// when sendmail closes its read side before we finish writing
// (typical when sendmail rejects fast). Pre-fix, no 'error' listener
// was on child.stdin, so Node lifted the error to a process-level
// uncaughtException and crashed the API process. Post-fix, the
// listener calls settle({ok:false,…}) and processQueue continues.
describe('R8 child.stdin EPIPE handler (#920)', () => {
  it('settles the delivery with ok=false instead of throwing when stdin emits error', async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as FakeChild;
      child.receivedInput = '';
      const stdin = new EventEmitter() as FakeStdin;
      stdin.write = () => {
        // Simulate sendmail closing stdin before we finished — emit
        // the EPIPE asynchronously, the way Node's real Writable does.
        setImmediate(() => stdin.emit('error', new Error('EPIPE')));
        return false;
      };
      stdin.end = () => {};
      child.stdin = stdin;
      child.stderr = new EventEmitter();
      child.kill = () => true;
      spawnedChildren.push(child);
      return child;
    });

    sendMail(['user@example.com'], 'subj', 'body');
    // If the EPIPE were unhandled, this await would never resolve
    // (uncaughtException would crash the test runner before drain
    // finished). Reaching the assertion at all proves the handler
    // wired the error into the normal failure path.
    await flushSendMailQueueForTests();

    // The delivery was retried up to MAX_ATTEMPTS, all failing with
    // EPIPE; logger.error is called once at give-up. We don't assert
    // exact spawn count here (3 attempts is the contract elsewhere) —
    // just that the test completed without an unhandled rejection.
    expect(loggerError.mock.calls.length).toBeGreaterThan(0);
  });
});
