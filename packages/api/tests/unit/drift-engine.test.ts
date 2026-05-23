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
    planConstraintRefs?: string[];
    planStandardRefs?: string[];
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
    planConstraintRefs: partial.planConstraintRefs ?? [],
    planStandardRefs: partial.planStandardRefs ?? [],
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

  describe('planConstraintRefs / planStandardRefs narrow severity (per-task)', () => {
    it('constraint change → "high" for tasks whose planConstraintRefs include it; "low" for others', async () => {
      tx.task.findMany.mockResolvedValueOnce([
        taskRow('t-touched', {
          boundPlanVersion: 1,
          planConstraintRefs: ['use postgres'],
        }),
        taskRow('t-unrelated', {
          boundPlanVersion: 1,
          planConstraintRefs: ['use kafka'],
        }),
      ]);
      tx.plan.findFirst.mockResolvedValueOnce(
        planRow(2, { constraints: ['use mysql', 'use kafka'] }), // 'use postgres' → 'use mysql'
      );
      tx.plan.findMany.mockResolvedValueOnce([
        planRow(1, { constraints: ['use postgres', 'use kafka'] }),
      ]);

      const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
      const byId = new Map(alerts.map((a) => [a.taskId, a]));
      expect(byId.get('t-touched')?.severity).toBe('high');
      expect(byId.get('t-touched')?.structuralSeverity).toBe('breaking');
      expect(byId.get('t-unrelated')?.severity).toBe('low');
      expect(byId.get('t-unrelated')?.structuralSeverity).toBe('low');
    });

    it('standard change → "medium" for tasks whose planStandardRefs include it; "low" for others', async () => {
      tx.task.findMany.mockResolvedValueOnce([
        taskRow('t-touched', {
          boundPlanVersion: 1,
          planStandardRefs: ['eslint'],
        }),
        taskRow('t-unrelated', {
          boundPlanVersion: 1,
          planStandardRefs: ['prettier'],
        }),
      ]);
      tx.plan.findFirst.mockResolvedValueOnce(
        planRow(2, { standards: ['biome', 'prettier'] }), // 'eslint' → 'biome'
      );
      tx.plan.findMany.mockResolvedValueOnce([planRow(1, { standards: ['eslint', 'prettier'] })]);

      const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
      const byId = new Map(alerts.map((a) => [a.taskId, a]));
      expect(byId.get('t-touched')?.severity).toBe('medium');
      expect(byId.get('t-unrelated')?.severity).toBe('low');
    });

    it('empty constraint refs ([]) preserve the legacy "depends on all" behavior — any constraint change is breaking', async () => {
      // Existing tasks in the DB have empty constraint refs (no migration
      // backfill); they MUST keep behaving conservatively until the owner
      // explicitly narrows them. Otherwise the migration would silently
      // downgrade existing alerts.
      tx.task.findMany.mockResolvedValueOnce([
        taskRow('t-legacy', { boundPlanVersion: 1 /* no refs */ }),
      ]);
      tx.plan.findFirst.mockResolvedValueOnce(planRow(2, { constraints: ['use mysql'] }));
      tx.plan.findMany.mockResolvedValueOnce([planRow(1, { constraints: ['use postgres'] })]);

      const { alerts } = await runDriftScan(tx as unknown as never, 'p1', 2);
      expect(alerts[0].severity).toBe('high'); // breaking
    });
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
  const driftUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const persistTx = {
    driftAlert: {
      createManyAndReturn: tx.driftAlert.createManyAndReturn,
      // R-051: persistDriftAlerts supersedes prior open alerts before
      // creating new ones. Provide updateMany so the supersede step has
      // somewhere to go.
      updateMany: driftUpdateMany,
    },
    task: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    executionRun: { updateMany: tx.executionRun.updateMany },
  };

  beforeEach(() => {
    persistTx.task.updateMany.mockClear();
    tx.executionRun.updateMany.mockClear();
    tx.driftAlert.createManyAndReturn.mockClear();
    driftUpdateMany.mockClear();
  });

  it('gates every task with severity >= medium via executionGate; leaves low-severity tasks alone (R-140)', async () => {
    setupCreate();
    await persistDriftAlerts(persistTx as unknown as never, 'p1', buildAlerts());

    // R-140: per-severity gate value, so the engine calls updateMany once
    // per non-empty severity bucket (here both 'high' and 'medium' have at
    // least one alert). Neither call writes to task.status — that column
    // is reserved for owner-meaningful state.
    expect(persistTx.task.updateMany).toHaveBeenCalledTimes(2);
    const calls = persistTx.task.updateMany.mock.calls.map(
      (c) =>
        c[0] as {
          where: { id: { in: string[] } };
          data: { executionGate?: string; status?: string };
        },
    );
    const highCall = calls.find((c) => c.data.executionGate === 'drift_high');
    const mediumCall = calls.find((c) => c.data.executionGate === 'drift_medium');
    expect(highCall, 'expected one updateMany with executionGate=drift_high').toBeDefined();
    expect(mediumCall, 'expected one updateMany with executionGate=drift_medium').toBeDefined();
    expect(highCall!.where.id.in).toEqual(['t-breaking-running']);
    expect(mediumCall!.where.id.in).toEqual(['t-medium-idle']);
    // Crucially: no call sets status='blocked' anymore. The system gate is
    // executionGate; status stays at whatever the lifecycle was before.
    for (const call of calls) {
      expect(call.data.status).toBeUndefined();
    }
    // And low-severity tasks are never touched.
    for (const call of calls) {
      expect(call.where.id.in).not.toContain('t-low-running');
    }
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
    expect(driftUpdateMany).not.toHaveBeenCalled();
  });

  // R-051: at most one open DriftAlert per task. Before writing the new
  // alerts, persistDriftAlerts must mark every prior open alert on the
  // affected tasks as resolved/superseded so the partial unique index
  // `drift_alerts_one_open_per_task` is satisfied. The supersede step has to
  // run BEFORE createManyAndReturn — otherwise the createMany would race the
  // index. We verify both the call ordering and the supersede shape here.
  describe('R-051: supersedes prior open alerts before creating new ones', () => {
    it('updates prior open alerts on the affected tasks to resolved/superseded before createMany', async () => {
      setupCreate();
      const alerts = buildAlerts();
      await persistDriftAlerts(persistTx as unknown as never, 'p1', alerts);

      expect(driftUpdateMany).toHaveBeenCalledTimes(1);
      const supersedeCall = driftUpdateMany.mock.calls[0][0] as {
        where: { taskId: { in: string[] }; status: string };
        data: {
          status: string;
          resolvedAction: string;
          resolvedBy: string;
          resolvedAt: Date;
        };
      };
      expect(supersedeCall.where.status).toBe('open');
      expect(supersedeCall.where.taskId.in.sort()).toEqual(alerts.map((a) => a.taskId).sort());
      expect(supersedeCall.data.status).toBe('resolved');
      expect(supersedeCall.data.resolvedAction).toBe('superseded');
      expect(supersedeCall.data.resolvedBy).toBe('system');
      expect(supersedeCall.data.resolvedAt).toBeInstanceOf(Date);

      const supersedeOrder = driftUpdateMany.mock.invocationCallOrder[0];
      const createOrder = tx.driftAlert.createManyAndReturn.mock.invocationCallOrder[0];
      expect(supersedeOrder).toBeLessThan(createOrder);
    });

    it('dedupes task ids in the supersede WHERE clause so duplicate alerts on the same task only filter once', async () => {
      tx.driftAlert.createManyAndReturn.mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }]);
      // Two alerts for the same task can happen if the diff yields one per
      // changed dimension; the supersede WHERE clause must still address
      // the task exactly once.
      const dupAlerts = [
        {
          taskId: 't-same',
          severity: 'high' as const,
          reason: 'changeA',
          currentPlanVersion: 2,
          taskBoundVersion: 1,
          hasRunningExecution: false,
        },
        {
          taskId: 't-same',
          severity: 'medium' as const,
          reason: 'changeB',
          currentPlanVersion: 2,
          taskBoundVersion: 1,
          hasRunningExecution: false,
        },
      ];

      await persistDriftAlerts(persistTx as unknown as never, 'p1', dupAlerts);

      const supersedeCall = driftUpdateMany.mock.calls[0][0] as {
        where: { taskId: { in: string[] } };
      };
      expect(supersedeCall.where.taskId.in).toEqual(['t-same']);
    });
  });
});
