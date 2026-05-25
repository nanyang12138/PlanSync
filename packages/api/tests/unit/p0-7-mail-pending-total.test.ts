/**
 * P0-7 / closes #541 #542 #561 #562 #576 #585 #586 #592 #599 #608 cluster
 * (subset that targets the SIGTERM drain "drained?" check):
 *
 * The instrumentation.ts SIGTERM drain reads `getPendingCount()` after the
 * `Promise.race([flush, timeout])` resolves. The previous wiring used
 * `_sendMailQueueLengthForTests` which only counted messages still
 * waiting in the queue array — it ignored:
 *   - in-flight `setImmediate(processQueue)` workers tracked in `inFlight`
 *   - the `processing` flag set while `processQueue` is awaiting sendmail
 *
 * As a result, a 5s drain that timed out while a sendmail child was still
 * being awaited would observe `pending=0` and call `process.exit(0)`,
 * SIGKILL'ing the in-flight delivery mid-write — exactly the silent-mail-
 * loss behaviour reviewers reported.
 *
 * The fix is the new `getPendingMailTotal()` helper which sums all three
 * signals. instrumentation.ts now uses it as `getPendingCount`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') })),
}));

vi.mock('../../src/lib/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  sendMail,
  flushSendMailQueueForTests,
  _sendMailQueueLengthForTests,
  getPendingMailTotal,
} from '../../src/lib/email';

describe('P0-7 getPendingMailTotal aggregates queue + inFlight + processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await flushSendMailQueueForTests();
  });

  it('returns 0 when nothing is queued or in flight', () => {
    expect(getPendingMailTotal()).toBe(0);
  });

  it('counts a freshly enqueued message immediately (queue + inFlight worker scheduled)', () => {
    sendMail(['alice@example.com'], 'hi', 'body');
    // Right after sendMail returns, scheduleProcess has registered the
    // setImmediate worker into `inFlight`, so the total includes it. The
    // legacy `_sendMailQueueLengthForTests` would also count it (queue
    // length is 1 here) but the point of `getPendingMailTotal` is to
    // never under-count compared to the legacy helper.
    expect(getPendingMailTotal()).toBeGreaterThanOrEqual(_sendMailQueueLengthForTests());
    expect(getPendingMailTotal()).toBeGreaterThan(0);
  });

  it('returns 0 once the queue is fully drained', async () => {
    sendMail(['alice@example.com'], 'hi', 'body');
    sendMail(['bob@example.com'], 'hi2', 'body2');
    await flushSendMailQueueForTests();
    expect(getPendingMailTotal()).toBe(0);
    expect(_sendMailQueueLengthForTests()).toBe(0);
  });
});
