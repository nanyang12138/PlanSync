/**
 * Unit coverage for the pause-ack-timeout sweep added to scanStaleExecutions.
 * The original 5min-stale and 30min-failed branches are exercised by the
 * integration suite (tests/integration/executions.test.ts G6/G7); this file
 * pins the new paused-run sweep without needing a database, including:
 *   - default threshold = 5min when env unset
 *   - env override is read on every scan (no restart required)
 *   - WHERE filter targets status='paused' specifically (no stale/running
 *     collateral) and falls back to startedAt when lastHeartbeatAt is null
 *   - atomic updateMany with WHERE status='paused' (race-safe vs concurrent
 *     ack_pause). count===0 → skip side-effects, do not crash.
 *   - emits the execution_superseded event + webhook + activity exactly once
 *     per swept run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  // empty queries for stale/failed branches keep them no-op so the test
  // focuses on the new paused branch
  executionRunFindMany: vi.fn(),
  executionRunUpdate: vi.fn(),
  executionRunUpdateMany: vi.fn(),
  activityCreate: vi.fn(),
  eventBusPublish: vi.fn(),
  dispatchWebhooks: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    executionRun: {
      findMany: mocks.executionRunFindMany,
      update: mocks.executionRunUpdate,
      updateMany: mocks.executionRunUpdateMany,
    },
    activity: { create: mocks.activityCreate },
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/event-bus', () => ({
  eventBus: { publish: mocks.eventBusPublish },
}));
vi.mock('@/lib/webhook', () => ({
  dispatchWebhooks: mocks.dispatchWebhooks,
}));

import { scanStaleExecutions } from '@/lib/heartbeat-scanner';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PLANSYNC_PAUSE_ACK_TIMEOUT_MS;

  // Three branches of findMany: failed (status=stale, lt 30min), stale
  // (status=running, lt 5min), and paused (status=paused, lt timeout).
  // Default to empty arrays; individual tests override with mockReturnValueOnce.
  mocks.executionRunFindMany
    .mockResolvedValueOnce([]) // failed branch
    .mockResolvedValueOnce([]) // stale branch
    .mockResolvedValueOnce([]); // paused branch
});

describe('scanStaleExecutions — pause-ack-timeout sweep', () => {
  it('targets status=paused with lastHeartbeatAt below the threshold', async () => {
    // override the third findMany call (the paused branch)
    mocks.executionRunFindMany.mockReset();
    mocks.executionRunFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await scanStaleExecutions();

    const pausedCall = mocks.executionRunFindMany.mock.calls[2]?.[0] as {
      where: { status: string; OR: unknown[] };
    };
    expect(pausedCall?.where?.status).toBe('paused');
    // Two branches in OR: heartbeat-based + startedAt-fallback for null
    // heartbeat. Both lt clauses must reference the same threshold Date.
    expect(Array.isArray(pausedCall?.where?.OR)).toBe(true);
    expect(pausedCall?.where?.OR).toHaveLength(2);
  });

  it('default timeout is 5 minutes when PLANSYNC_PAUSE_ACK_TIMEOUT_MS unset', async () => {
    const before = Date.now();
    await scanStaleExecutions();
    const after = Date.now();

    const pausedCall = mocks.executionRunFindMany.mock.calls[2]?.[0] as {
      where: { OR: Array<{ lastHeartbeatAt?: { lt: Date } }> };
    };
    const threshold = pausedCall?.where?.OR?.[0]?.lastHeartbeatAt?.lt;
    expect(threshold).toBeInstanceOf(Date);
    const elapsed = before - (threshold as Date).getTime();
    // ~5 minutes between "now" and the threshold (allow scheduling jitter)
    expect(elapsed).toBeGreaterThanOrEqual(5 * 60 * 1000 - 50);
    expect(elapsed).toBeLessThanOrEqual(after - before + 5 * 60 * 1000 + 50);
  });

  it('PLANSYNC_PAUSE_ACK_TIMEOUT_MS override is honoured each scan (no restart)', async () => {
    process.env.PLANSYNC_PAUSE_ACK_TIMEOUT_MS = '12345';
    const before = Date.now();
    await scanStaleExecutions();
    const pausedCall = mocks.executionRunFindMany.mock.calls[2]?.[0] as {
      where: { OR: Array<{ lastHeartbeatAt?: { lt: Date } }> };
    };
    const threshold = pausedCall?.where?.OR?.[0]?.lastHeartbeatAt?.lt as Date;
    const elapsed = before - threshold.getTime();
    expect(elapsed).toBeGreaterThanOrEqual(12345 - 50);
    expect(elapsed).toBeLessThanOrEqual(12345 + 100);
  });

  it('invalid env value (NaN, negative, zero) falls back to the default', async () => {
    for (const bad of ['not-a-number', '-1', '0']) {
      mocks.executionRunFindMany.mockReset();
      mocks.executionRunFindMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      process.env.PLANSYNC_PAUSE_ACK_TIMEOUT_MS = bad;
      const before = Date.now();
      await scanStaleExecutions();
      const pausedCall = mocks.executionRunFindMany.mock.calls[2]?.[0] as {
        where: { OR: Array<{ lastHeartbeatAt?: { lt: Date } }> };
      };
      const threshold = (pausedCall?.where?.OR?.[0]?.lastHeartbeatAt?.lt as Date).getTime();
      expect(before - threshold).toBeGreaterThanOrEqual(5 * 60 * 1000 - 50);
    }
  });

  it('on a hit, performs atomic updateMany(status=paused) → superseded, then publishes + webhook + activity', async () => {
    mocks.executionRunFindMany.mockReset();
    mocks.executionRunFindMany
      .mockResolvedValueOnce([]) // failed
      .mockResolvedValueOnce([]) // stale
      .mockResolvedValueOnce([
        {
          id: 'run-1',
          taskId: 'task-1',
          executorName: 'genie',
          task: { projectId: 'proj-1', title: 'do the thing' },
        },
      ]);
    mocks.executionRunUpdateMany.mockResolvedValueOnce({ count: 1 });

    await scanStaleExecutions();

    expect(mocks.executionRunUpdateMany).toHaveBeenCalledTimes(1);
    const updateCall = mocks.executionRunUpdateMany.mock.calls[0][0] as {
      where: { id: string; status: string };
      data: { status: string; endedAt: Date; outputSummary: string };
    };
    expect(updateCall.where).toEqual({ id: 'run-1', status: 'paused' });
    expect(updateCall.data.status).toBe('superseded');
    expect(updateCall.data.endedAt).toBeInstanceOf(Date);
    expect(updateCall.data.outputSummary).toMatch(/pause-ack-timeout/);

    expect(mocks.eventBusPublish).toHaveBeenCalledWith(
      'proj-1',
      'execution_superseded',
      expect.objectContaining({ runId: 'run-1', reason: 'pause_timeout' }),
    );
    expect(mocks.dispatchWebhooks).toHaveBeenCalledWith(
      'proj-1',
      'execution_superseded',
      expect.objectContaining({ runId: 'run-1', reason: 'pause_timeout' }),
    );
    expect(mocks.activityCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'execution_superseded',
        projectId: 'proj-1',
        actorName: 'system',
        actorType: 'system',
        metadata: expect.objectContaining({ runId: 'run-1', reason: 'pause_timeout' }),
      }),
    });
  });

  it('race: count===0 → skip side-effects (concurrent ack_pause won)', async () => {
    mocks.executionRunFindMany.mockReset();
    mocks.executionRunFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'run-raced',
          taskId: 'task-x',
          executorName: 'genie',
          task: { projectId: 'proj-x', title: 'something' },
        },
      ]);
    mocks.executionRunUpdateMany.mockResolvedValueOnce({ count: 0 });

    await scanStaleExecutions();

    // Update fired, but count was 0 → no side-effects
    expect(mocks.executionRunUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.eventBusPublish).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhooks).not.toHaveBeenCalled();
    expect(mocks.activityCreate).not.toHaveBeenCalled();
  });

  it('multiple paused runs are processed independently — one race-lost row does not block the rest', async () => {
    mocks.executionRunFindMany.mockReset();
    mocks.executionRunFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'r-won',
          taskId: 't1',
          executorName: 'genie',
          task: { projectId: 'p1', title: 't1' },
        },
        {
          id: 'r-lost',
          taskId: 't2',
          executorName: 'genie',
          task: { projectId: 'p1', title: 't2' },
        },
      ]);
    mocks.executionRunUpdateMany
      .mockResolvedValueOnce({ count: 1 }) // r-won
      .mockResolvedValueOnce({ count: 0 }); // r-lost (raced)

    await scanStaleExecutions();

    expect(mocks.executionRunUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.eventBusPublish).toHaveBeenCalledTimes(1);
    expect(mocks.eventBusPublish).toHaveBeenCalledWith(
      'p1',
      'execution_superseded',
      expect.objectContaining({ runId: 'r-won' }),
    );
    expect(mocks.activityCreate).toHaveBeenCalledTimes(1);
  });
});
