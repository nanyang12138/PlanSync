import { describe, it, expect, vi, beforeEach } from 'vitest';

// R-007: drift-engine 事件/邮件 must be moved out of the database transaction
// so that a rolled-back $transaction never produces "ghost notifications".
//
// These unit tests exercise `persistDriftAlerts` and `dispatchDriftSideEffects`
// with mocked tx / prisma / event-bus / email. We assert two things:
//   1. `persistDriftAlerts` (the function called inside the tx) never invokes
//      eventBus.publish, eventBus.publishToUser, or sendMail itself.
//   2. When a caller wraps `persistDriftAlerts` in a $transaction and a later
//      step (e.g. tx.task.updateMany) throws, no SSE/email side effect occurs
//      — the side-effect dispatch only runs after the tx resolves.
//
// A separate happy-path test verifies that `dispatchDriftSideEffects` still
// fires both channels (email + per-user SSE) when explicitly invoked.

const eventBusPublish = vi.fn();
const eventBusPublishToUser = vi.fn();
vi.mock('../../src/lib/event-bus', () => ({
  eventBus: {
    publish: (...args: unknown[]) => eventBusPublish(...args),
    publishToUser: (...args: unknown[]) => eventBusPublishToUser(...args),
  },
}));

const sendMailMock = vi.fn();
vi.mock('../../src/lib/email', () => ({
  sendMail: (...args: unknown[]) => sendMailMock(...args),
  userEmail: (n: string) => `${n}@example.test`,
}));

// prisma is only referenced by enrichDriftAlertsWithAi (unused here) but the
// module-level import still needs to resolve.
vi.mock('../../src/lib/prisma', () => ({
  prisma: {
    task: { findMany: vi.fn() },
    plan: { findMany: vi.fn() },
    driftAlert: { update: vi.fn() },
    planDiff: { findUnique: vi.fn() },
    projectMember: { findMany: vi.fn() },
  },
}));

import {
  persistDriftAlerts,
  dispatchDriftSideEffects,
  type DriftNotificationPlan,
} from '../../src/lib/drift-engine';

const PROJECT_ID = 'p1';
const TASK_ID = 't1';

type MockTx = {
  driftAlert: { createManyAndReturn: ReturnType<typeof vi.fn> };
  task: {
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  projectMember: { findMany: ReturnType<typeof vi.fn> };
};

function makeTx(overrides: Partial<MockTx> = {}): MockTx {
  return {
    driftAlert: {
      createManyAndReturn: vi.fn().mockResolvedValue([
        {
          id: 'alert-1',
          taskId: TASK_ID,
          severity: 'high',
          reason: 'task bound to v1, now v2',
          projectId: PROJECT_ID,
          status: 'open',
        },
      ]),
    },
    task: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: TASK_ID, title: 'Hardening: refactor X', assignee: 'alice' }]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    projectMember: {
      findMany: vi.fn().mockResolvedValue([{ name: 'alice' }]),
    },
    ...overrides,
  } as MockTx;
}

const SAMPLE_ALERTS = [
  {
    taskId: TASK_ID,
    severity: 'high' as const,
    reason: 'task bound to v1, now v2',
    currentPlanVersion: 2,
    taskBoundVersion: 1,
  },
];

describe('R-007: persistDriftAlerts has no side effects', () => {
  beforeEach(() => {
    eventBusPublish.mockReset();
    eventBusPublishToUser.mockReset();
    sendMailMock.mockReset();
  });

  it('does not publish SSE during persistence', async () => {
    const tx = makeTx();
    await persistDriftAlerts(tx as never, PROJECT_ID, SAMPLE_ALERTS);
    expect(eventBusPublish).not.toHaveBeenCalled();
    expect(eventBusPublishToUser).not.toHaveBeenCalled();
  });

  it('does not send email during persistence', async () => {
    const tx = makeTx();
    await persistDriftAlerts(tx as never, PROJECT_ID, SAMPLE_ALERTS);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('returns alerts + notifications plan for callers to dispatch later', async () => {
    const tx = makeTx();
    const result = await persistDriftAlerts(tx as never, PROJECT_ID, SAMPLE_ALERTS);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]?.id).toBe('alert-1');
    expect(result.notifications).toEqual([
      {
        assignee: 'alice',
        affected: [
          {
            title: 'Hardening: refactor X',
            reason: 'task bound to v1, now v2',
            severity: 'high',
          },
        ],
      },
    ]);
  });

  it('returns empty results when no alerts provided (no side effects)', async () => {
    const tx = makeTx();
    const result = await persistDriftAlerts(tx as never, PROJECT_ID, []);
    expect(result).toEqual({ alerts: [], notifications: [] });
    expect(tx.driftAlert.createManyAndReturn).not.toHaveBeenCalled();
    expect(eventBusPublish).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('uses tx (not prisma) for member/task reads — observable via tx.findMany call counts', async () => {
    const tx = makeTx();
    await persistDriftAlerts(tx as never, PROJECT_ID, SAMPLE_ALERTS);
    expect(tx.task.findMany).toHaveBeenCalledTimes(1);
    expect(tx.projectMember.findMany).toHaveBeenCalledTimes(1);
  });

  it('skips notifications for non-human assignees (agents)', async () => {
    // ProjectMember.findMany returning [] simulates the assignee being an agent
    // (not a human) so no email/per-user push should be planned.
    const tx = makeTx({
      projectMember: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const result = await persistDriftAlerts(tx as never, PROJECT_ID, SAMPLE_ALERTS);
    expect(result.notifications).toEqual([]);
  });
});

describe('R-007: rollback safety — no ghost SSE/mail when tx fails', () => {
  beforeEach(() => {
    eventBusPublish.mockReset();
    eventBusPublishToUser.mockReset();
    sendMailMock.mockReset();
  });

  it('does not publish SSE when a later tx step throws (caller never reaches dispatch)', async () => {
    // Simulate the route shape:
    //   const { notifications } = await prisma.$transaction(async (tx) => {
    //     const result = await persistDriftAlerts(tx, ...);
    //     await tx.task.updateMany(...);  // <-- throws
    //     return result;
    //   });
    //   dispatchDriftSideEffects(projectId, notifications);  // <-- never runs
    const tx = makeTx({
      task: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: TASK_ID, title: 'will rollback', assignee: 'alice' }]),
        updateMany: vi.fn().mockRejectedValue(new Error('DB exploded')),
      },
    });

    const txCall = async () => {
      const result = await persistDriftAlerts(tx as never, PROJECT_ID, SAMPLE_ALERTS);
      // Caller's own write — fails, triggering rollback in a real $transaction.
      await tx.task.updateMany({ where: { id: TASK_ID }, data: { status: 'blocked' } });
      // This dispatch must be unreachable because the await above throws.
      dispatchDriftSideEffects(PROJECT_ID, result.notifications);
    };

    await expect(txCall()).rejects.toThrow('DB exploded');

    // Critical invariant: nothing was sent / published.
    expect(eventBusPublish).not.toHaveBeenCalled();
    expect(eventBusPublishToUser).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('does not publish SSE when persistDriftAlerts itself throws', async () => {
    const tx = makeTx({
      driftAlert: {
        createManyAndReturn: vi.fn().mockRejectedValue(new Error('insert failed')),
      },
    });

    await expect(persistDriftAlerts(tx as never, PROJECT_ID, SAMPLE_ALERTS)).rejects.toThrow(
      'insert failed',
    );

    expect(eventBusPublish).not.toHaveBeenCalled();
    expect(eventBusPublishToUser).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

describe('R-007: dispatchDriftSideEffects (happy path)', () => {
  beforeEach(() => {
    eventBusPublish.mockReset();
    eventBusPublishToUser.mockReset();
    sendMailMock.mockReset();
    sendMailMock.mockReturnValue(true);
  });

  it('publishes per-user SSE for each assignee and sends one email', () => {
    const plan: DriftNotificationPlan = [
      {
        assignee: 'alice',
        affected: [{ title: 'T1', reason: 'r1', severity: 'high' }],
      },
      {
        assignee: 'bob',
        affected: [
          { title: 'T2', reason: 'r2', severity: 'medium' },
          { title: 'T3', reason: 'r3', severity: 'low' },
        ],
      },
    ];

    dispatchDriftSideEffects(PROJECT_ID, plan);

    expect(sendMailMock).toHaveBeenCalledTimes(2);
    expect(sendMailMock.mock.calls[0]?.[0]).toEqual(['alice@example.test']);
    expect(sendMailMock.mock.calls[1]?.[0]).toEqual(['bob@example.test']);

    expect(eventBusPublishToUser).toHaveBeenCalledTimes(2);
    expect(eventBusPublishToUser.mock.calls[0]).toEqual([
      'alice',
      'drift_detected',
      PROJECT_ID,
      { alerts: plan[0]!.affected },
    ]);
    expect(eventBusPublishToUser.mock.calls[1]).toEqual([
      'bob',
      'drift_detected',
      PROJECT_ID,
      { alerts: plan[1]!.affected },
    ]);

    // The project-level publish belongs to the route, not this helper.
    expect(eventBusPublish).not.toHaveBeenCalled();
  });

  it('is a no-op when the notification plan is empty', () => {
    dispatchDriftSideEffects(PROJECT_ID, []);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(eventBusPublish).not.toHaveBeenCalled();
    expect(eventBusPublishToUser).not.toHaveBeenCalled();
  });
});
