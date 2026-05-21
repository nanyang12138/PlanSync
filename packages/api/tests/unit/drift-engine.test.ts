/**
 * Drift engine unit tests — drift v2 (structural severity).
 *
 * Previously this file contained an inlined copy of the old "severity by task
 * status" heuristic and tested *that* copy, not the engine. Once the engine
 * adopted structural diffing, the inline copy became dishonest — the tests
 * passed but did not constrain real behaviour.
 *
 * The exhaustive coverage of the pure classifier lives in
 * `packages/shared/tests/drift/severity.test.ts` (deterministic, no DB).
 * This file covers what only the engine can: mapping the structural severity
 * onto the persisted `DriftAlert.severity` enum and carrying the
 * "has-running-execution" signal through to `persistDriftAlerts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above all imports, so the mock objects must
// be declared via vi.hoisted to live in the same hoisted scope.
const mocks = vi.hoisted(() => ({
  taskFindMany: vi.fn(),
  planFindFirst: vi.fn(),
  planFindMany: vi.fn(),
  driftAlertCreateManyAndReturn: vi.fn(),
  executionRunUpdateMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    task: { findMany: mocks.taskFindMany },
    plan: { findFirst: mocks.planFindFirst, findMany: mocks.planFindMany },
    driftAlert: { createManyAndReturn: mocks.driftAlertCreateManyAndReturn },
    executionRun: { updateMany: mocks.executionRunUpdateMany },
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/email', () => ({ sendMail: vi.fn(), userEmail: (n: string) => `${n}@x` }));
vi.mock('@/lib/event-bus', () => ({
  eventBus: { publish: vi.fn(), publishToUser: vi.fn() },
}));
vi.mock('@/lib/ai/client', () => ({ aiClient: { isAvailable: false } }));
vi.mock('@/lib/ai/plan-diff', () => ({ getOrCreatePlanDiff: vi.fn() }));
vi.mock('@/lib/ai/impact-analysis', () => ({ analyzeTaskImpact: vi.fn() }));

// Same surface as the engine expects but bound to the hoisted mocks so each
// test sees the assertions made via mocks.*.
const tx = {
  task: { findMany: mocks.taskFindMany },
  plan: { findFirst: mocks.planFindFirst, findMany: mocks.planFindMany },
  driftAlert: { createManyAndReturn: mocks.driftAlertCreateManyAndReturn },
  executionRun: { updateMany: mocks.executionRunUpdateMany },
} as const;

import { runDriftScan, persistDriftAlerts } from '@/lib/drift-engine';

function planRow(version: number, partial: Partial<Record<string, unknown>> = {}) {
  return {
    id: `plan-${version}`,
    projectId: 'p1',
    version,
    title: `v${version}`,
    goal: 'ship it',
    scope: 'web',
    constraints: [] as string[],
    standards: [] as string[],
    deliverables: [] as string[],
    openQuestions: [] as string[],
    requiredReviewers: [] as string[],
    ...partial,
  };
}

function taskRow(
  id: string,
  partial: {
    boundPlanVersion: number;
    status?: string;
    planDeliverableRefs?: string[];
    running?: boolean;
  },
) {
  return {
    id,
    projectId: 'p1',
    title: `Task ${id}`,
    status: partial.status ?? 'todo',
    boundPlanVersion: partial.boundPlanVersion,
    planDeliverableRefs: partial.planDeliverableRefs ?? [],
    executionRuns: partial.running ? [{ status: 'running' }] : [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runDriftScan — structural severity is mapped onto the persisted enum', () => {
  it('goal change → severity="high" for every task regardless of status', async () => {
    tx.task.findMany.mockResolvedValueOnce([
      taskRow('t-todo', { boundPlanVersion: 1, status: 'todo' }),
      taskRow('t-done', { boundPlanVersion: 1, status: 'done' }),
    ]);
    tx.plan.findFirst.mockResolvedValueOnce(planRow(2, { goal: 'ship it BIGGER' }));
    tx.plan.findMany.mockResolvedValueOnce([planRow(1)]);

    // Cast to any so we can hand the same mock surface where the engine
    // expects a Prisma client / TransactionClient. The shape we use is
    // narrower than either type so the cast is safe at the test boundary.
    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);

    expect(alerts).toHaveLength(2);
    for (const a of alerts) {
      expect(a.severity).toBe('high');
      expect(a.structuralSeverity).toBe('breaking');
    }
  });

  it('only-scope change → severity="medium" for tasks not referencing changed deliverables', async () => {
    tx.task.findMany.mockResolvedValueOnce([
      taskRow('t1', { boundPlanVersion: 1, status: 'in_progress' }),
    ]);
    tx.plan.findFirst.mockResolvedValueOnce(planRow(2, { scope: 'web + mobile' }));
    tx.plan.findMany.mockResolvedValueOnce([planRow(1)]);

    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('medium');
    expect(alerts[0].structuralSeverity).toBe('medium');
  });

  it('change touches only unreferenced items → severity="low"', async () => {
    tx.task.findMany.mockResolvedValueOnce([
      // Task explicitly references "docs" — added "graphql api" should NOT
      // change the contract.
      taskRow('t1', { boundPlanVersion: 1, planDeliverableRefs: ['docs'] }),
    ]);
    tx.plan.findFirst.mockResolvedValueOnce(
      planRow(2, { deliverables: ['rest', 'docs', 'graphql api'] }),
    );
    tx.plan.findMany.mockResolvedValueOnce([planRow(1, { deliverables: ['rest', 'docs'] })]);

    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('low');
    expect(alerts[0].structuralSeverity).toBe('low');
  });

  it('hasRunningExecution is carried on the alert independent of severity', async () => {
    tx.task.findMany.mockResolvedValueOnce([
      taskRow('t-running', { boundPlanVersion: 1, running: true }),
      taskRow('t-idle', { boundPlanVersion: 1, running: false }),
    ]);
    tx.plan.findFirst.mockResolvedValueOnce(planRow(2));
    tx.plan.findMany.mockResolvedValueOnce([planRow(1)]);

    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    expect(alerts.find((a) => a.taskId === 't-running')?.hasRunningExecution).toBe(true);
    expect(alerts.find((a) => a.taskId === 't-idle')?.hasRunningExecution).toBe(false);
  });

  it('falls back to severity="high" when the bound plan row is missing (defensive default)', async () => {
    tx.task.findMany.mockResolvedValueOnce([taskRow('t1', { boundPlanVersion: 99 })]);
    tx.plan.findFirst.mockResolvedValueOnce(planRow(2));
    tx.plan.findMany.mockResolvedValueOnce([]); // no v99 row

    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    expect(alerts[0].severity).toBe('high');
    expect(alerts[0].structuralSeverity).toBe('breaking');
    expect(alerts[0].reason).toMatch(/cannot compute structural diff/i);
  });

  it('cancelled tasks are excluded from the scan (unchanged contract)', async () => {
    // The where clause uses status notIn ['cancelled']. We assert that the
    // engine asks for that by inspecting the findMany call args.
    tx.task.findMany.mockResolvedValueOnce([]);
    await runDriftScan(tx as unknown as never, 'p1', 2);
    const call = tx.task.findMany.mock.calls[0]?.[0] as {
      where?: { status?: { notIn?: string[] } };
    };
    expect(call?.where?.status?.notIn).toContain('cancelled');
  });

  it('returns no alerts when all tasks are already on the new version', async () => {
    tx.task.findMany.mockResolvedValueOnce([]);
    const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
    expect(alerts).toEqual([]);
    expect(tx.plan.findFirst).not.toHaveBeenCalled();
  });
});

describe('persistDriftAlerts — pause rule keys off (severity >= medium) AND hasRunningExecution', () => {
  function setupCreate() {
    tx.driftAlert.createManyAndReturn.mockResolvedValueOnce([
      { id: 'a1' },
      { id: 'a2' },
      { id: 'a3' },
    ]);
    tx.executionRun.updateMany.mockResolvedValue({ count: 0 });
  }

  function buildAlerts() {
    return [
      // breaking + running → pause + block
      {
        taskId: 't-breaking-running',
        severity: 'high' as const,
        reason: 'breaking',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: true,
      },
      // medium + idle → block but no pause (nothing to interrupt)
      {
        taskId: 't-medium-idle',
        severity: 'medium' as const,
        reason: 'scope changed',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: false,
      },
      // low + running → must NOT pause and must NOT block; the change does
      // not affect this task by definition.
      {
        taskId: 't-low-running',
        severity: 'low' as const,
        reason: 'unrelated change',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: true,
      },
    ];
  }

  // Prisma-shaped tx; we expose enough of the API for persistDriftAlerts.
  const persistTx = {
    driftAlert: { createManyAndReturn: tx.driftAlert.createManyAndReturn },
    task: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    executionRun: { updateMany: tx.executionRun.updateMany },
  };

  beforeEach(() => {
    persistTx.task.updateMany.mockClear();
    tx.executionRun.updateMany.mockClear();
    tx.driftAlert.createManyAndReturn.mockClear();
  });

  it('blocks every task with severity >= medium; leaves low-severity tasks alone', async () => {
    setupCreate();
    await persistDriftAlerts(persistTx as unknown as never, 'p1', buildAlerts());

    expect(persistTx.task.updateMany).toHaveBeenCalledTimes(1);
    const blockCall = persistTx.task.updateMany.mock.calls[0][0] as {
      where: { id: { in: string[] } };
      data: { status: string };
    };
    expect(blockCall.data.status).toBe('blocked');
    expect(blockCall.where.id.in.sort()).toEqual(['t-breaking-running', 't-medium-idle']);
    expect(blockCall.where.id.in).not.toContain('t-low-running');
  });

  it('pauses only the subset of blocked tasks that have a running execution', async () => {
    setupCreate();
    await persistDriftAlerts(persistTx as unknown as never, 'p1', buildAlerts());

    expect(tx.executionRun.updateMany).toHaveBeenCalledTimes(1);
    const pauseCall = tx.executionRun.updateMany.mock.calls[0][0] as {
      where: { taskId: { in: string[] }; status: string };
      data: { status: string };
    };
    expect(pauseCall.data.status).toBe('paused');
    expect(pauseCall.where.status).toBe('running'); // race protection
    expect(pauseCall.where.taskId.in).toEqual(['t-breaking-running']);
  });

  it('does nothing when all alerts are low severity (no block, no pause)', async () => {
    tx.driftAlert.createManyAndReturn.mockResolvedValueOnce([{ id: 'a1' }]);

    await persistDriftAlerts(persistTx as unknown as never, 'p1', [
      {
        taskId: 't-low',
        severity: 'low',
        reason: 'unrelated',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
        hasRunningExecution: true,
      },
    ]);

    expect(persistTx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.executionRun.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing on an empty alert array (cheap exit)', async () => {
    await persistDriftAlerts(persistTx as unknown as never, 'p1', []);
    expect(tx.driftAlert.createManyAndReturn).not.toHaveBeenCalled();
    expect(persistTx.task.updateMany).not.toHaveBeenCalled();
    expect(tx.executionRun.updateMany).not.toHaveBeenCalled();
  });
});
