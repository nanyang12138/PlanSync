/**
 * R-007 — drift-engine 事件/邮件移到事务提交后
 *
 * persistDriftAlerts 必须只做 DB 写入，不能在 $transaction 内调用
 * SSE publish / sendMail。否则事务回滚后会发出"鬼通知"。
 *
 * dispatchDriftNotifications 必须由 caller 在事务提交之后调用，
 * 才会真正触发 SSE/email 副作用。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all side-effect collaborators BEFORE importing drift-engine.
vi.mock('@/lib/prisma', () => ({
  prisma: {
    task: { findMany: vi.fn() },
    projectMember: { findMany: vi.fn() },
    plan: { findMany: vi.fn() },
    driftAlert: { update: vi.fn() },
    planDiff: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/event-bus', () => ({
  eventBus: {
    publish: vi.fn(),
    publishToUser: vi.fn(),
  },
}));

vi.mock('@/lib/email', () => ({
  sendMail: vi.fn().mockReturnValue(true),
  userEmail: (name: string) => `${name}@example.test`,
}));

vi.mock('@/lib/ai/client', () => ({
  aiClient: { isAvailable: false },
}));
vi.mock('@/lib/ai/plan-diff', () => ({ getOrCreatePlanDiff: vi.fn() }));
vi.mock('@/lib/ai/impact-analysis', () => ({ analyzeTaskImpact: vi.fn() }));

import { persistDriftAlerts, dispatchDriftNotifications } from '@/lib/drift-engine';
import { eventBus } from '@/lib/event-bus';
import { sendMail } from '@/lib/email';
import { prisma } from '@/lib/prisma';

type Tx = {
  driftAlert: { createManyAndReturn: ReturnType<typeof vi.fn> };
  task: { updateMany: ReturnType<typeof vi.fn> };
};

function buildTx(overrides: Partial<Tx> = {}): Tx {
  return {
    driftAlert: {
      createManyAndReturn:
        overrides.driftAlert?.createManyAndReturn ??
        vi.fn().mockResolvedValue([{ id: 'a1', taskId: 't1', severity: 'high' }]),
    },
    task: {
      updateMany: overrides.task?.updateMany ?? vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

const sampleAlerts = [
  {
    taskId: 't1',
    severity: 'high' as const,
    reason: 'Task "T1" bound to plan v1, now v2',
    currentPlanVersion: 2,
    taskBoundVersion: 1,
  },
];

describe('R-007 — persistDriftAlerts has no in-tx SSE/email side-effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not call eventBus.publish, eventBus.publishToUser or sendMail', async () => {
    const tx = buildTx();
    await persistDriftAlerts(tx as any, 'p1', sampleAlerts);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(eventBus.publishToUser).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('only invokes tx writes (driftAlert + task.updateMany), no global prisma reads', async () => {
    const tx = buildTx();
    await persistDriftAlerts(tx as any, 'p1', sampleAlerts);

    expect(tx.driftAlert.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(tx.task.updateMany).toHaveBeenCalledTimes(1);
    // The global prisma.task.findMany used to be called inside the function;
    // after R-007 it must not run during persist (moved to
    // dispatchDriftNotifications).
    expect(prisma.task.findMany as any).not.toHaveBeenCalled();
    expect(prisma.projectMember.findMany as any).not.toHaveBeenCalled();
  });

  it('when tx.task.updateMany throws inside a $transaction wrapper, no notifications fire', async () => {
    const tx = buildTx({
      task: { updateMany: vi.fn().mockRejectedValue(new Error('boom')) },
    });

    // Simulate the caller pattern used by activate/reactivate routes:
    //   await prisma.$transaction(async (tx) => {
    //     await persistDriftAlerts(tx, ...);
    //   });
    //   if (committed) await dispatchDriftNotifications(...);
    let committed = false;
    await expect(
      (async () => {
        await persistDriftAlerts(tx as any, 'p1', sampleAlerts);
        committed = true;
      })(),
    ).rejects.toThrow('boom');

    expect(committed).toBe(false);

    // Caller would skip dispatch because the tx never resolved — verify our
    // wrapping pattern indeed suppresses any side-effect publishers.
    if (committed) {
      await dispatchDriftNotifications('p1', sampleAlerts);
    }

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(eventBus.publishToUser).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('R-007 — dispatchDriftNotifications runs only after caller invokes it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes per-user SSE and sends email for human assignees', async () => {
    (prisma.task.findMany as any).mockResolvedValue([{ id: 't1', title: 'T1', assignee: 'alice' }]);
    (prisma.projectMember.findMany as any).mockResolvedValue([{ name: 'alice' }]);

    await dispatchDriftNotifications('p1', sampleAlerts);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect((sendMail as any).mock.calls[0][0]).toEqual(['alice@example.test']);
    expect(eventBus.publishToUser).toHaveBeenCalledWith(
      'alice',
      'drift_detected',
      'p1',
      expect.objectContaining({
        alerts: expect.arrayContaining([
          expect.objectContaining({ title: 'T1', severity: 'high' }),
        ]),
      }),
    );
  });

  it('does not email non-human members (e.g. agent assignees)', async () => {
    (prisma.task.findMany as any).mockResolvedValue([{ id: 't1', title: 'T1', assignee: 'genie' }]);
    // genie is not in the human members result
    (prisma.projectMember.findMany as any).mockResolvedValue([]);

    await dispatchDriftNotifications('p1', sampleAlerts);

    expect(sendMail).not.toHaveBeenCalled();
    expect(eventBus.publishToUser).not.toHaveBeenCalled();
  });

  it('is a no-op when there are no alerts', async () => {
    await dispatchDriftNotifications('p1', []);
    expect(prisma.task.findMany as any).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(eventBus.publishToUser).not.toHaveBeenCalled();
  });
});
