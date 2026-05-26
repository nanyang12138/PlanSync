/**
 * Closes #710 — persistDriftAlerts must collapse same-task alerts to
 * a single row before writing, otherwise the partial unique index
 * `drift_alerts_one_open_per_task` (status='open') rejects the
 * createMany and rolls back the whole plan-activate transaction.
 *
 * Today's only caller (`runDriftScan`) emits one alert per task, so
 * this is defensive — but the function's signature and header
 * comment already advertise multi-dimensional alerts and a future
 * caller would crash production.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  eventBus: { publish: vi.fn(), publishToUser: vi.fn() },
}));

vi.mock('@/lib/email', () => ({
  sendMail: vi.fn().mockReturnValue(true),
  userEmail: (name: string) => `${name}@example.test`,
}));

vi.mock('@/lib/ai/client', () => ({ aiClient: { isAvailable: false } }));
vi.mock('@/lib/ai/plan-diff', () => ({ getOrCreatePlanDiff: vi.fn() }));
vi.mock('@/lib/ai/impact-analysis', () => ({ analyzeTaskImpact: vi.fn() }));

import { persistDriftAlerts } from '@/lib/drift-engine';

type Tx = {
  driftAlert: {
    createManyAndReturn: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  task: { updateMany: ReturnType<typeof vi.fn> };
  executionRun: { updateMany: ReturnType<typeof vi.fn> };
};

function buildTx(): Tx {
  return {
    driftAlert: {
      createManyAndReturn: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    task: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    executionRun: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
}

describe('persistDriftAlerts — same-task dedupe (closes #710)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('collapses two alerts on the same taskId into one createMany row', async () => {
    const tx = buildTx();
    await persistDriftAlerts(tx as any, 'p1', [
      {
        taskId: 't1',
        severity: 'medium',
        reason: 'scope shifted',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: false,
      },
      {
        taskId: 't1',
        severity: 'high',
        reason: 'breaking — agent contract changed',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: false,
      },
    ]);

    expect(tx.driftAlert.createManyAndReturn).toHaveBeenCalledTimes(1);
    const call = tx.driftAlert.createManyAndReturn.mock.calls[0]![0] as {
      data: Array<{ taskId: string; severity: string; reason: string }>;
    };
    expect(call.data).toHaveLength(1);
    // Highest-severity alert wins; otherwise the lower-severity reason
    // would mask a real breaking-change signal in the operator UI.
    expect(call.data[0]!.severity).toBe('high');
    expect(call.data[0]!.reason).toMatch(/breaking/);
  });

  it('keeps distinct taskIds as separate rows', async () => {
    const tx = buildTx();
    await persistDriftAlerts(tx as any, 'p1', [
      {
        taskId: 't1',
        severity: 'high',
        reason: 'r1',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: false,
      },
      {
        taskId: 't2',
        severity: 'medium',
        reason: 'r2',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: false,
      },
    ]);

    const call = tx.driftAlert.createManyAndReturn.mock.calls[0]![0] as {
      data: Array<{ taskId: string }>;
    };
    expect(call.data.map((d) => d.taskId).sort()).toEqual(['t1', 't2']);
  });

  it('does not double-gate a task whose duplicate alerts span severities', async () => {
    // Pre-fix, blockingAlerts would contain BOTH the medium and the high
    // entries for t1, so highTaskIds=[t1] AND mediumTaskIds=[t1] — the
    // second updateMany overwrites the first to drift_medium and the
    // banner copy says 're-orient' instead of 'breaking'. After dedup
    // by max severity, only the high entry survives, and t1 lands on
    // drift_high alone.
    const tx = buildTx();
    await persistDriftAlerts(tx as any, 'p1', [
      {
        taskId: 't1',
        severity: 'medium',
        reason: 'm',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: false,
      },
      {
        taskId: 't1',
        severity: 'high',
        reason: 'h',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: false,
      },
    ]);

    // High path called with [t1]; medium path either not called or
    // called with [].
    const taskUpdateCalls = tx.task.updateMany.mock.calls;
    const highCalls = taskUpdateCalls.filter(
      (c) => (c[0] as { data: { executionGate: string } }).data.executionGate === 'drift_high',
    );
    const mediumCalls = taskUpdateCalls.filter(
      (c) => (c[0] as { data: { executionGate: string } }).data.executionGate === 'drift_medium',
    );
    expect(highCalls).toHaveLength(1);
    const highWhere = highCalls[0]![0] as { where: { id: { in: string[] } } };
    expect(highWhere.where.id.in).toEqual(['t1']);
    // Medium updateMany either not invoked, or invoked with empty list
    // — never with t1 in it.
    for (const c of mediumCalls) {
      const w = c[0] as { where: { id: { in: string[] } } };
      expect(w.where.id.in).not.toContain('t1');
    }
  });

  it('preserves existing single-alert behaviour (regression guard)', async () => {
    const tx = buildTx();
    await persistDriftAlerts(tx as any, 'p1', [
      {
        taskId: 't1',
        severity: 'medium',
        reason: 'r1',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: true,
      },
    ]);

    expect(tx.driftAlert.createManyAndReturn).toHaveBeenCalledTimes(1);
    const data = (tx.driftAlert.createManyAndReturn.mock.calls[0]![0] as { data: unknown[] }).data;
    expect(data).toHaveLength(1);
  });

  it('preserves hasRunningExecution=true across same-task dedupe — high-on-top (closes #1206 #1154 #1147 #1141)', async () => {
    // The kept alert (high severity) has `hasRunningExecution=false`,
    // but a lower-severity alert on the same task signals a running
    // execution. Pre-fix the dedupe dropped the running-flag and the
    // running run was NOT paused, leaving an agent free to keep
    // hitting the now-stale plan. Post-fix the OR-merge guarantees
    // the pause step still fires.
    const tx = buildTx();
    await persistDriftAlerts(tx as any, 'p1', [
      {
        taskId: 't1',
        severity: 'high',
        reason: 'breaking change',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: false,
      },
      {
        taskId: 't1',
        severity: 'medium',
        reason: 'scope shift',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: true,
      },
    ]);

    // The pause path is `executionRun.updateMany({ where: { taskId:{in},
    // status:'running' }, data:{ status:'paused' } })`. Since severity
    // is at least 'medium' (any high or medium alert is "blocking"
    // per persistDriftAlerts), the running execution on t1 must be
    // among the pause targets.
    const pauseCalls = tx.executionRun.updateMany.mock.calls;
    expect(pauseCalls.length).toBeGreaterThanOrEqual(1);
    const pausedTaskIds = pauseCalls.flatMap(
      (c) => (c[0] as { where: { taskId: { in: string[] } } }).where.taskId.in,
    );
    expect(pausedTaskIds).toContain('t1');
  });

  it('preserves hasRunningExecution=true when the running-flag is on the lower-rank alert', async () => {
    // Same property but with insertion order reversed — exercises
    // the path where `existing.hasRunningExecution` was set true on
    // the initial insert and the higher-severity alert arrives
    // second (the post-fix `||` merge must keep the flag).
    const tx = buildTx();
    await persistDriftAlerts(tx as any, 'p1', [
      {
        taskId: 't1',
        severity: 'medium',
        reason: 'scope shift',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: true,
      },
      {
        taskId: 't1',
        severity: 'high',
        reason: 'breaking change',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: false,
      },
    ]);

    const pauseCalls = tx.executionRun.updateMany.mock.calls;
    expect(pauseCalls.length).toBeGreaterThanOrEqual(1);
    const pausedTaskIds = pauseCalls.flatMap(
      (c) => (c[0] as { where: { taskId: { in: string[] } } }).where.taskId.in,
    );
    expect(pausedTaskIds).toContain('t1');
  });
});
