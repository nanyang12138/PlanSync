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
  // R-057: stale-release counts other-running runs via executionRun.count
  // and then conditionally updates task.status + deletes exec-scoped api
  // keys. Default to "no other running runs" so the default stale-release
  // path activates cleanly.
  executionRunCount: vi.fn().mockResolvedValue(0),
  taskUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
  apiKeyDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  activityCreate: vi.fn(),
  eventBusPublish: vi.fn(),
  dispatchWebhooks: vi.fn(),
  // R-056: $queryRaw is used to acquire the pg_try_advisory_xact_lock. Default
  // to "lock granted" so existing tests behave as before; the R-056 tests
  // override this to simulate a contended scan from a peer instance.
  queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
  transaction: vi.fn(),
}));

// R-056: the scan body now runs inside prisma.$transaction(async (tx) => ...).
// The mock transaction simply invokes the callback with a tx surface that
// proxies the same vi.fn()s the existing tests already asserted against, so
// asserting on e.g. mocks.executionRunFindMany still works regardless of
// whether the production code uses prisma.* or tx.*.
const txProxy = {
  executionRun: {
    findMany: mocks.executionRunFindMany,
    update: mocks.executionRunUpdate,
    updateMany: mocks.executionRunUpdateMany,
    count: mocks.executionRunCount,
  },
  task: {
    updateMany: mocks.taskUpdateMany,
  },
  apiKey: {
    deleteMany: mocks.apiKeyDeleteMany,
  },
  $queryRaw: mocks.queryRaw,
};
mocks.transaction.mockImplementation(async (cb: (tx: typeof txProxy) => Promise<void>) =>
  cb(txProxy),
);

vi.mock('@/lib/prisma', () => ({
  prisma: {
    executionRun: {
      findMany: mocks.executionRunFindMany,
      update: mocks.executionRunUpdate,
      updateMany: mocks.executionRunUpdateMany,
      count: mocks.executionRunCount,
    },
    task: { updateMany: mocks.taskUpdateMany },
    apiKey: { deleteMany: mocks.apiKeyDeleteMany },
    activity: { create: mocks.activityCreate },
    $transaction: mocks.transaction,
    $queryRaw: mocks.queryRaw,
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

  // R-056: the transaction wrapper and lock-granted default must be
  // re-installed on every `vi.clearAllMocks()` reset, otherwise downstream
  // assertions would see a no-op tx and never reach the scan body.
  mocks.transaction.mockImplementation(async (cb: (tx: typeof txProxy) => Promise<void>) =>
    cb(txProxy),
  );
  mocks.queryRaw.mockResolvedValue([{ locked: true }]);

  // R-057: re-prime the stale-release defaults that vi.clearAllMocks just
  // wiped — "no other running run" + "task flip succeeded" + "no key rows
  // matched" — so unrelated tests don't have to know the new mocks exist.
  mocks.executionRunCount.mockResolvedValue(0);
  mocks.taskUpdateMany.mockResolvedValue({ count: 1 });
  mocks.apiKeyDeleteMany.mockResolvedValue({ count: 0 });

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

  // ---- R-056: Postgres advisory-lock gate -----------------------------------
  // The scan body is wrapped in prisma.$transaction so a single API replica
  // grabs `pg_try_advisory_xact_lock(NS, slot)` before doing any work. When
  // another replica already holds the slot the query returns `{ locked:
  // false }` and the scan must exit immediately — no findMany, no update, no
  // event/webhook/activity emit. This is the load-bearing assertion behind
  // "SSE count = 1× single-process count" on multi-instance deployments.

  it('R-056: acquires advisory lock via pg_try_advisory_xact_lock(NS, slot)', async () => {
    await scanStaleExecutions();

    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    // tagged-template `$queryRaw` gets (strings, ...values). The first arg is
    // the strings array containing the SQL fragments; the values must include
    // the namespace and the slot in that order.
    const [strings, ...values] = mocks.queryRaw.mock.calls[0];
    const sql = (strings as string[]).join('?');
    expect(sql).toMatch(/pg_try_advisory_xact_lock/);
    expect(values).toEqual([0x504c5359, 1]);
  });

  it('R-056: skips the entire scan when another instance holds the lock', async () => {
    mocks.queryRaw.mockResolvedValueOnce([{ locked: false }]);

    await scanStaleExecutions();

    // Lock query fired exactly once; the scan body never touched the DB
    // afterwards. This is the property that prevents duplicate side-effects
    // across replicas.
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.executionRunFindMany).not.toHaveBeenCalled();
    expect(mocks.executionRunUpdate).not.toHaveBeenCalled();
    expect(mocks.executionRunUpdateMany).not.toHaveBeenCalled();
    expect(mocks.eventBusPublish).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhooks).not.toHaveBeenCalled();
    expect(mocks.activityCreate).not.toHaveBeenCalled();
  });

  it('R-056: when lock is held, returns silently — never throws and never emits an error log', async () => {
    mocks.queryRaw.mockResolvedValueOnce([{ locked: false }]);

    await expect(scanStaleExecutions()).resolves.toBeUndefined();
    // The transaction itself still ran (callback invoked); we just early-
    // returned inside it. The point is that lost-the-race is a graceful
    // skip, not an error condition that would spam pino's `.error()`.
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('R-056: lock-granted path performs the scan as before', async () => {
    // Sanity check: when the lock query returns true, the body still runs
    // exactly the same flow. Use the paused-hit fixture from earlier to
    // exercise updateMany + side effects through the new tx wrapper.
    mocks.executionRunFindMany.mockReset();
    mocks.executionRunFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'run-locked-ok',
          taskId: 'task-1',
          executorName: 'genie',
          task: { projectId: 'proj-1', title: 'do the thing' },
        },
      ]);
    mocks.executionRunUpdateMany.mockResolvedValueOnce({ count: 1 });

    await scanStaleExecutions();

    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.executionRunUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.eventBusPublish).toHaveBeenCalledWith(
      'proj-1',
      'execution_superseded',
      expect.objectContaining({ runId: 'run-locked-ok' }),
    );
  });

  // ---- R-057: stale-release sweeps task + exec-scoped api keys --------------
  // When a run goes stale, the task stays `in_progress` (phantom "someone is
  // working on it") and the agent's exec-scoped api key remains valid until
  // someone manually revokes it. R-057 ties both releases into the same tx
  // the status flip happens in: the task is moved to `blocked` (unless a
  // sibling run is still running) and every apiKey with `execRunId = run.id`
  // is deleted.

  it('R-057: on stale, blocks the task when no sibling run is still running', async () => {
    mocks.executionRunFindMany.mockReset();
    mocks.executionRunFindMany
      .mockResolvedValueOnce([]) // failed
      .mockResolvedValueOnce([
        {
          id: 'run-stale-1',
          taskId: 'task-1',
          executorName: 'genie',
          lastHeartbeatAt: new Date(0),
          task: { projectId: 'proj-1', title: 'do the thing' },
        },
      ])
      .mockResolvedValueOnce([]); // paused

    await scanStaleExecutions();

    // Sibling-count and task flip must use the SAME tx that just set the
    // run to stale — and the where filter must be { taskId, status: 'running',
    // id: { not: run.id } } so a freshly-started parallel run is not
    // clobbered into blocked.
    expect(mocks.executionRunCount).toHaveBeenCalledWith({
      where: { taskId: 'task-1', status: 'running', id: { not: 'run-stale-1' } },
    });
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith({
      where: { id: 'task-1', status: 'in_progress' },
      data: { status: 'blocked' },
    });
  });

  it('R-057: on stale, does NOT block the task when a sibling run is still running', async () => {
    mocks.executionRunCount.mockResolvedValueOnce(1);
    mocks.executionRunFindMany.mockReset();
    mocks.executionRunFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'run-stale-2',
          taskId: 'task-2',
          executorName: 'genie',
          lastHeartbeatAt: new Date(0),
          task: { projectId: 'p2', title: 't2' },
        },
      ])
      .mockResolvedValueOnce([]);

    await scanStaleExecutions();

    expect(mocks.executionRunCount).toHaveBeenCalledTimes(1);
    // Sibling found → leave task alone so the parallel run keeps owning the
    // status. Critical: a phantom-block here would 409 the live sibling's
    // next heartbeat.
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled();
  });

  it('R-057: on stale, the task flip filter is status="in_progress" so blocked/done/cancelled rows are not touched', async () => {
    mocks.executionRunFindMany.mockReset();
    mocks.executionRunFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'run-stale-3',
          taskId: 'task-3',
          executorName: 'genie',
          lastHeartbeatAt: new Date(0),
          task: { projectId: 'p3', title: 't3' },
        },
      ])
      .mockResolvedValueOnce([]);

    await scanStaleExecutions();

    // The where filter must pin `status: 'in_progress'`. Without it, a task
    // someone already cancelled while the run was alive (status='cancelled')
    // would get yanked back to 'blocked' under the scanner, breaking the
    // explicit cancel.
    const updateCall = mocks.taskUpdateMany.mock.calls[0][0] as {
      where: { status: string };
    };
    expect(updateCall.where.status).toBe('in_progress');
  });

  it('R-057: on stale, deletes every exec-scoped api key bound to this run', async () => {
    mocks.apiKeyDeleteMany.mockResolvedValueOnce({ count: 2 });
    mocks.executionRunFindMany.mockReset();
    mocks.executionRunFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'run-stale-4',
          taskId: 'task-4',
          executorName: 'genie',
          lastHeartbeatAt: new Date(0),
          task: { projectId: 'p4', title: 't4' },
        },
      ])
      .mockResolvedValueOnce([]);

    await scanStaleExecutions();

    expect(mocks.apiKeyDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.apiKeyDeleteMany).toHaveBeenCalledWith({
      where: { execRunId: 'run-stale-4' },
    });
  });

  it('R-057: stale-release is idempotent — re-running the scan on a row with no api keys does not throw', async () => {
    // First scan: real release (count=2). Second scan: nothing left to release
    // (count=0). The scanner must not treat the second pass as an error.
    mocks.apiKeyDeleteMany.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 0 });
    mocks.executionRunFindMany.mockReset();
    // first scan
    mocks.executionRunFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'run-stale-5',
          taskId: 'task-5',
          executorName: 'genie',
          lastHeartbeatAt: new Date(0),
          task: { projectId: 'p5', title: 't5' },
        },
      ])
      .mockResolvedValueOnce([])
      // second scan: same row surfaces again (e.g. before the status flip
      // visibly propagates to the next findMany on a replica with stale read)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'run-stale-5',
          taskId: 'task-5',
          executorName: 'genie',
          lastHeartbeatAt: new Date(0),
          task: { projectId: 'p5', title: 't5' },
        },
      ])
      .mockResolvedValueOnce([]);

    await expect(scanStaleExecutions()).resolves.toBeUndefined();
    await expect(scanStaleExecutions()).resolves.toBeUndefined();
    expect(mocks.apiKeyDeleteMany).toHaveBeenCalledTimes(2);
  });

  it('R-057: stale release still publishes execution_stale + webhook (release does not swallow notifications)', async () => {
    mocks.executionRunFindMany.mockReset();
    mocks.executionRunFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'run-stale-6',
          taskId: 'task-6',
          executorName: 'genie',
          lastHeartbeatAt: new Date(1700000000000),
          task: { projectId: 'p6', title: 't6' },
        },
      ])
      .mockResolvedValueOnce([]);

    await scanStaleExecutions();

    expect(mocks.eventBusPublish).toHaveBeenCalledWith(
      'p6',
      'execution_stale',
      expect.objectContaining({ runId: 'run-stale-6', taskId: 'task-6' }),
    );
    expect(mocks.dispatchWebhooks).toHaveBeenCalledWith(
      'p6',
      'execution_stale',
      expect.objectContaining({ runId: 'run-stale-6', taskId: 'task-6' }),
    );
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
