import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// child_process must be mocked before email.ts is imported, because email.ts
// captures spawnSync at import time only when called.
vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
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
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    await flushSendMailQueueForTests();
    warnSpy.mockRestore();
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

  it('gives up after MAX_ATTEMPTS (3) and logs a warning', async () => {
    spawnSyncMock.mockImplementation(fail);

    sendMail(['dave@example.com'], 'subj', 'body');
    await flushSendMailQueueForTests();

    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalled();
    const calledWith = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(calledWith).toMatch(/giving up/);
  });

  it('escapes header-injection attempts in the To/Subject fields', async () => {
    spawnSyncMock.mockImplementation(ok);

    sendMail(
      ['eve@example.com\nBcc: leaked@evil.com'],
      'normal\r\nX-Injected: yes',
      'body',
    );
    await flushSendMailQueueForTests();

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const opts = spawnSyncMock.mock.calls[0][2] as { input: string };
    const message = opts.input;
    expect(message).not.toMatch(/^Bcc:/m);
    expect(message).not.toMatch(/^X-Injected:/m);
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
