import { describe, it, expect, vi, beforeEach } from 'vitest';

// R-001: AI must never auto-resolve drift or unblock tasks. These tests exercise
// `enrichDriftAlertsWithAi` directly with mocked prisma/AI modules and assert
// that even with a very high compatibility score the function (a) keeps the
// DriftAlert open and (b) does not touch task.status, and (c) does not publish
// a `drift_resolved` event.

const driftAlertUpdate = vi.fn();
const taskUpdateMany = vi.fn();
const taskFindMany = vi.fn();
const planFindMany = vi.fn();
const planDiffFindUnique = vi.fn();

vi.mock('../../src/lib/prisma', () => ({
  prisma: {
    task: {
      findMany: (...args: unknown[]) => taskFindMany(...args),
      updateMany: (...args: unknown[]) => taskUpdateMany(...args),
    },
    plan: {
      findMany: (...args: unknown[]) => planFindMany(...args),
    },
    driftAlert: {
      update: (...args: unknown[]) => driftAlertUpdate(...args),
    },
    planDiff: {
      findUnique: (...args: unknown[]) => planDiffFindUnique(...args),
    },
  },
}));

const eventBusPublish = vi.fn();
vi.mock('../../src/lib/event-bus', () => ({
  eventBus: {
    publish: (...args: unknown[]) => eventBusPublish(...args),
    publishToUser: vi.fn(),
  },
}));

vi.mock('../../src/lib/ai/client', () => ({
  aiClient: { isAvailable: true, complete: vi.fn() },
}));

vi.mock('../../src/lib/ai/plan-diff', () => ({
  getOrCreatePlanDiff: vi.fn(async (_p: string, fromPlanId: string, toPlanId: string) => ({
    fromPlanId,
    toPlanId,
    summary: 'mock diff',
    breakingChanges: false,
    additions: [],
    removals: [],
    modifications: [],
  })),
}));

const analyzeTaskImpactMock = vi.fn();
vi.mock('../../src/lib/ai/impact-analysis', () => ({
  analyzeTaskImpact: (...args: unknown[]) => analyzeTaskImpactMock(...args),
}));

vi.mock('../../src/lib/email', () => ({
  sendMail: vi.fn(),
  userEmail: (n: string) => `${n}@example.test`,
}));

import { enrichDriftAlertsWithAi } from '../../src/lib/drift-engine';

const PROJECT_ID = 'p1';
const ACTIVE_PLAN_ID = 'plan-active';
const BOUND_PLAN_ID = 'plan-old';
const TASK_ID = 'task-1';
const ALERT_ID = 'alert-1';

function setupHappyPath(score: number) {
  taskFindMany.mockResolvedValue([
    {
      id: TASK_ID,
      projectId: PROJECT_ID,
      title: 'Sample task',
      description: '',
      type: 'feature',
      status: 'blocked',
      boundPlanVersion: 1,
    },
  ]);
  planFindMany.mockResolvedValue([{ id: BOUND_PLAN_ID, projectId: PROJECT_ID, version: 1 }]);
  planDiffFindUnique.mockResolvedValue({ id: 'diff-1' });
  analyzeTaskImpactMock.mockResolvedValue({
    compatibilityScore: score,
    compatible: score > 70,
    suggestedAction: score > 70 ? 'no_impact' : 'rebind',
    reasoning: 'mock reasoning',
    affectedAreas: ['areaA'],
    riskLevel: 'low',
  });
  driftAlertUpdate.mockResolvedValue({ id: ALERT_ID });
}

describe('R-001: enrichDriftAlertsWithAi never auto-resolves drift', () => {
  beforeEach(() => {
    driftAlertUpdate.mockReset();
    taskUpdateMany.mockReset();
    taskFindMany.mockReset();
    planFindMany.mockReset();
    planDiffFindUnique.mockReset();
    eventBusPublish.mockReset();
    analyzeTaskImpactMock.mockReset();
  });

  it('keeps drift alert open even when compatibility score is 95', async () => {
    setupHappyPath(95);

    await enrichDriftAlertsWithAi(PROJECT_ID, ACTIVE_PLAN_ID, [{ id: ALERT_ID, taskId: TASK_ID }]);

    expect(driftAlertUpdate).toHaveBeenCalledTimes(1);
    const call = driftAlertUpdate.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: ALERT_ID });
    // Must NOT silently mark the alert as resolved or stamp resolvedBy: 'system'.
    expect(call.data).not.toHaveProperty('status');
    expect(call.data).not.toHaveProperty('resolvedAction');
    expect(call.data).not.toHaveProperty('resolvedAt');
    expect(call.data).not.toHaveProperty('resolvedBy');
    // The advisory fields must still be persisted so the UI can surface them.
    expect(call.data).toMatchObject({
      compatibilityScore: 95,
      impactAnalysis: 'mock reasoning',
      suggestedAction: 'no_impact',
      affectedAreas: ['areaA'],
      planDiffId: 'diff-1',
    });
  });

  it('does not unblock the task even at score 95 (task remains blocked / in_progress)', async () => {
    setupHappyPath(95);

    await enrichDriftAlertsWithAi(PROJECT_ID, ACTIVE_PLAN_ID, [{ id: ALERT_ID, taskId: TASK_ID }]);

    // The previous behavior called task.updateMany to flip blocked → in_progress.
    // The R-001 fix removes that call entirely.
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  it('does not publish a drift_resolved event from the AI path', async () => {
    setupHappyPath(95);

    await enrichDriftAlertsWithAi(PROJECT_ID, ACTIVE_PLAN_ID, [{ id: ALERT_ID, taskId: TASK_ID }]);

    const resolvedCalls = eventBusPublish.mock.calls.filter((c) => c[1] === 'drift_resolved');
    expect(resolvedCalls).toEqual([]);
  });

  it('persists suggestedAction verbatim from the AI (not coerced to no_impact)', async () => {
    // Even when score crosses the old 70 threshold, suggestedAction must reflect
    // exactly what the AI proposed — we no longer override it.
    setupHappyPath(80);
    analyzeTaskImpactMock.mockResolvedValue({
      compatibilityScore: 80,
      compatible: true,
      suggestedAction: 'rebind',
      reasoning: 'still requires rebind',
      affectedAreas: [],
      riskLevel: 'low',
    });

    await enrichDriftAlertsWithAi(PROJECT_ID, ACTIVE_PLAN_ID, [{ id: ALERT_ID, taskId: TASK_ID }]);

    const call = driftAlertUpdate.mock.calls[0]?.[0] as {
      data: { suggestedAction: string; status?: string };
    };
    expect(call.data.suggestedAction).toBe('rebind');
    expect(call.data.status).toBeUndefined();
  });

  it('low compatibility score still only writes advisory fields', async () => {
    setupHappyPath(20);

    await enrichDriftAlertsWithAi(PROJECT_ID, ACTIVE_PLAN_ID, [{ id: ALERT_ID, taskId: TASK_ID }]);

    const call = driftAlertUpdate.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(Object.keys(call.data).sort()).toEqual(
      [
        'affectedAreas',
        'compatibilityScore',
        'impactAnalysis',
        'planDiffId',
        'suggestedAction',
      ].sort(),
    );
    expect(taskUpdateMany).not.toHaveBeenCalled();
  });

  it('does nothing when aiClient is unavailable', async () => {
    const { aiClient } = await import('../../src/lib/ai/client');
    const original = aiClient.isAvailable;
    Object.defineProperty(aiClient, 'isAvailable', {
      configurable: true,
      get: () => false,
    });

    try {
      await enrichDriftAlertsWithAi(PROJECT_ID, ACTIVE_PLAN_ID, [
        { id: ALERT_ID, taskId: TASK_ID },
      ]);
      expect(driftAlertUpdate).not.toHaveBeenCalled();
      expect(taskUpdateMany).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(aiClient, 'isAvailable', {
        configurable: true,
        value: original,
      });
    }
  });
});
