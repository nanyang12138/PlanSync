import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sendMail,
  flushMailQueue,
  __setSendmailDriverForTest,
  __resetMailQueueForTest,
} from '../../src/lib/email';

describe('R-113: sendMail async queue', () => {
  beforeEach(() => {
    __resetMailQueueForTest();
  });

  afterEach(() => {
    __resetMailQueueForTest();
  });

  it('returns synchronously without waiting for the driver to complete', async () => {
    let driverStarted = 0;
    let driverFinished = 0;
    __setSendmailDriverForTest(async () => {
      driverStarted++;
      await new Promise((r) => setTimeout(r, 25));
      driverFinished++;
      return { ok: true };
    });

    const before = Date.now();
    const enqueued = sendMail(['alice@example.com'], 'subj', 'hello');
    const elapsed = Date.now() - before;

    expect(enqueued).toBe(true);
    expect(elapsed).toBeLessThan(5);
    expect(driverStarted).toBe(0);
    expect(driverFinished).toBe(0);

    await flushMailQueue();
    expect(driverStarted).toBe(1);
    expect(driverFinished).toBe(1);
  });

  it('delivers a well-formed RFC-822 message with sanitised headers', async () => {
    const received: string[] = [];
    __setSendmailDriverForTest(async (msg) => {
      received.push(msg);
      return { ok: true };
    });

    sendMail(['bob@example.com'], 'subject\nwith\rnewlines', 'body line 1');
    await flushMailQueue();

    expect(received).toHaveLength(1);
    const msg = received[0]!;
    expect(msg).toMatch(/^To: bob@example\.com$/m);
    expect(msg).toMatch(/^Subject: subject with newlines$/m);
    expect(msg).toMatch(/^From: /m);
    expect(msg).toMatch(/^Content-Type: text\/plain; charset=utf-8$/m);
    expect(msg).toContain('\n\nbody line 1');
  });

  it('returns false synchronously and never invokes the driver when recipients are all undeliverable', async () => {
    let driverCalls = 0;
    __setSendmailDriverForTest(async () => {
      driverCalls++;
      return { ok: true };
    });

    const ok = sendMail(['bob-demo-1776932148306@example.com'], 'subj', 'body');
    expect(ok).toBe(false);
    await flushMailQueue();
    expect(driverCalls).toBe(0);
  });

  it('retries transient driver failures and eventually succeeds', async () => {
    let calls = 0;
    __setSendmailDriverForTest(async () => {
      calls++;
      if (calls < 3) return { ok: false, detail: `transient ${calls}` };
      return { ok: true };
    });

    // Speed up retry backoff by patching setTimeout? Easier: just accept the
    // ~750ms total (250 + 500ms). The test still asserts the final outcome.
    sendMail(['carol@example.com'], 'subj', 'body');
    await flushMailQueue();

    expect(calls).toBe(3);
  }, 5_000);

  it('gives up after MAX_ATTEMPTS when the driver keeps failing', async () => {
    let calls = 0;
    __setSendmailDriverForTest(async () => {
      calls++;
      return { ok: false, detail: 'permanent' };
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    sendMail(['dan@example.com'], 'subj', 'body');
    await flushMailQueue();

    expect(calls).toBe(3);
    // At least one warning should mention "giving up"
    const messages = warnSpy.mock.calls.map((args) => args.join(' '));
    expect(messages.some((m) => m.includes('giving up'))).toBe(true);

    warnSpy.mockRestore();
  }, 5_000);

  it('flushMailQueue resolves immediately when the queue is empty', async () => {
    const start = Date.now();
    await flushMailQueue();
    expect(Date.now() - start).toBeLessThan(20);
  });

  it('drains multiple enqueued messages in order', async () => {
    const subjects: string[] = [];
    __setSendmailDriverForTest(async (msg) => {
      const m = msg.match(/^Subject: (.+)$/m);
      if (m) subjects.push(m[1]!);
      return { ok: true };
    });

    sendMail(['a@example.com'], 'msg-1', 'b');
    sendMail(['a@example.com'], 'msg-2', 'b');
    sendMail(['a@example.com'], 'msg-3', 'b');
    await flushMailQueue();

    expect(subjects).toEqual(['msg-1', 'msg-2', 'msg-3']);
  });

  it('survives a driver that throws', async () => {
    let calls = 0;
    __setSendmailDriverForTest(async () => {
      calls++;
      throw new Error('boom');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    sendMail(['e@example.com'], 'subj', 'body');
    await flushMailQueue();

    expect(calls).toBe(3);
    warnSpy.mockRestore();
  }, 5_000);
});
