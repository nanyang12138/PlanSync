import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// child_process must be mocked before email.ts is imported, because email.ts
// captures spawnSync at import time only when called.
vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
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

import { spawnSync } from 'child_process';
import {
  sendMail,
  flushSendMailQueueForTests,
  _sendMailQueueLengthForTests,
} from '../../src/lib/email';

const spawnSyncMock = spawnSync as unknown as ReturnType<typeof vi.fn>;

function ok() {
  return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
}

function fail() {
  return { status: 1, stdout: Buffer.from(''), stderr: Buffer.from('rejected') };
}

describe('R-113: sendMail asynchronous queue', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    loggerWarn.mockReset();
    loggerError.mockReset();
  });

  afterEach(async () => {
    await flushSendMailQueueForTests();
  });

  it('returns synchronously without invoking sendmail in the same tick', async () => {
    spawnSyncMock.mockImplementation(ok);

    const accepted = sendMail(['alice@example.com'], 'hi', 'body');

    expect(accepted).toBe(true);
    // spawnSync must NOT have been called synchronously — the queue worker
    // runs via setImmediate, so the request handler returns first.
    expect(spawnSyncMock).not.toHaveBeenCalled();

    await flushSendMailQueueForTests();

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('drops messages with no deliverable recipients without queueing', async () => {
    spawnSyncMock.mockImplementation(ok);

    // Long numeric suffix marks an auto-generated demo address; should be filtered.
    const accepted = sendMail(['bob-demo-1776932148306@example.com'], 'hi', 'body');

    expect(accepted).toBe(false);
    expect(_sendMailQueueLengthForTests()).toBe(0);
    await flushSendMailQueueForTests();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('retries on transient sendmail failure (eventual success)', async () => {
    let calls = 0;
    spawnSyncMock.mockImplementation(() => {
      calls += 1;
      if (calls < 2) return fail();
      return ok();
    });

    sendMail(['carol@example.com'], 'subj', 'body');
    await flushSendMailQueueForTests();

    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after MAX_ATTEMPTS (3) and logs via logger.error (#316 / #350)', async () => {
    spawnSyncMock.mockImplementation(fail);

    sendMail(['dave@example.com'], 'subj', 'body');
    await flushSendMailQueueForTests();

    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
    // Structured logger.error so downstream observability sees this —
    // the legacy console.warn made delivery failures invisible to pino
    // subscribers and to drift-engine's error-budget surface.
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
    spawnSyncMock.mockImplementation(ok);

    sendMail(['eve@example.com\nBcc: leaked@evil.com'], 'normal\r\nX-Injected: yes', 'body');
    await flushSendMailQueueForTests();

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const opts = spawnSyncMock.mock.calls[0][2] as { input: string };
    const message = opts.input;
    expect(message).not.toMatch(/^Bcc:/m);
    expect(message).not.toMatch(/^X-Injected:/m);
  });

  // ---- #318 / #352: synchronous backpressure cap -------------------------

  it('#318/#352: rejects synchronously and logs warn when the queue is at the limit', async () => {
    // Block sendmail so the worker doesn't drain while we fill the queue.
    let resolveSendmail: () => void = () => {};
    const sendmailGate = new Promise<void>((r) => {
      resolveSendmail = r;
    });
    spawnSyncMock.mockImplementation(() => {
      // The sync mock cannot await, but we can spin until the gate is
      // released by polling; since processQueue runs in a microtask, we
      // simulate a slow sendmail by returning ok() AFTER the test pushes
      // through enough mail to hit the cap. Simpler: just succeed (so
      // the worker drains) and instead saturate the queue BEFORE
      // setImmediate fires. We achieve that by stuffing the queue
      // synchronously with sendMail() calls, all of which run on the
      // same microtask before the first setImmediate.
      return ok();
    });

    // Default QUEUE_LIMIT is 1000; pushing 1000 messages fills it. The
    // 1001st must reject synchronously.
    let acceptedCount = 0;
    let rejectedCount = 0;
    for (let i = 0; i < 1001; i += 1) {
      const accepted = sendMail([`u${i}@example.com`], `s${i}`, 'b');
      if (accepted) acceptedCount += 1;
      else rejectedCount += 1;
    }
    expect(acceptedCount).toBe(1000);
    expect(rejectedCount).toBe(1);

    // logger.warn was called for the rejected message, with diagnostic
    // context (queueLength, limit) — without that the operator cannot
    // tell a queue-full reject from a no-recipients reject.
    const warnCall = loggerWarn.mock.calls.find(
      (c) => typeof c[1] === 'string' && /queue full/i.test(c[1] as string),
    );
    expect(warnCall, 'expected logger.warn call mentioning "queue full"').toBeDefined();
    const ctx = warnCall![0] as Record<string, unknown>;
    expect(ctx.queueLength).toBe(1000);
    expect(ctx.limit).toBe(1000);

    // Drain so afterEach is fast.
    resolveSendmail();
    await flushSendMailQueueForTests();
  });

  it('processes multiple queued messages in order', async () => {
    spawnSyncMock.mockImplementation(ok);

    sendMail(['a@example.com'], 's1', 'b');
    sendMail(['b@example.com'], 's2', 'b');
    sendMail(['c@example.com'], 's3', 'b');

    expect(spawnSyncMock).not.toHaveBeenCalled();

    await flushSendMailQueueForTests();

    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
    const subjects = spawnSyncMock.mock.calls.map((c) => {
      const inp = (c[2] as { input: string }).input;
      const m = inp.match(/^Subject: (.*)$/m);
      return m ? m[1] : '';
    });
    expect(subjects).toEqual(['s1', 's2', 's3']);
  });
});
