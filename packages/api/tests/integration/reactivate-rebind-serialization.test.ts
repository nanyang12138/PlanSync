// Serialization / in-transaction re-read hardening for the plan-rollback and
// rebind flows. These three routes mutate the same plan/task/run columns the
// `activate` route does, but historically did NOT pick up the concurrency
// guards activate received (R-048 advisory lock, #903/#984/#1167 guarded
// in-tx status flip). They each read version-sensitive state OUTSIDE the
// transaction at READ COMMITTED, then wrote based on that stale snapshot.
//
// The tests below inject the exact stale-snapshot a concurrent `plan_activate`
// would expose (same technique as r206-start-activate-race.test.ts) by
// stubbing the OUTER production-prisma read. The in-transaction reads added by
// the fix go through the tx client, which the stub does not intercept, so the
// route observes reality and either rejects (reactivate) or binds to the
// current version (rebind / drift_resolve).
//
// Pre-fix, each of these returns the WRONG result on the injected snapshot:
//   * reactivate    → unconditionally activates a non-superseded plan
//   * /rebind       → binds the task to the stale (already-superseded) version
//   * drift_resolve → same stale bind via action=rebind
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST as reactivatePost } from '@/app/api/projects/[projectId]/plans/[planId]/reactivate/route';
import { POST as taskRebindPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/rebind/route';
import { POST as driftPost } from '@/app/api/projects/[projectId]/drifts/[driftId]/route';
import {
  makeReq,
  createTestProject,
  cleanupProject,
  testPrisma,
  spyOnProductionPrisma,
} from '../helpers/request';

const owner = 'srz-owner';

describe('reactivate / rebind serialization + in-tx re-read', () => {
  let projectId: string;
  const restorers: Array<() => void> = [];

  beforeEach(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterEach(async () => {
    while (restorers.length > 0) {
      try {
        restorers.pop()?.();
      } catch {
        /* best-effort */
      }
    }
    if (projectId) await cleanupProject(projectId);
  });

  async function createPlan(version: number, status: string) {
    return testPrisma.plan.create({
      data: {
        projectId,
        title: `v${version}`,
        goal: `goal v${version}`,
        scope: `scope v${version}`,
        version,
        status,
        createdBy: owner,
        ...(status === 'active' ? { activatedAt: new Date(), activatedBy: owner } : {}),
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });
  }

  async function createTaskBoundTo(version: number) {
    const t = await testPrisma.task.create({
      data: {
        projectId,
        title: 'srz task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: version,
        agentConstraints: [],
      },
    });
    return t.id;
  }

  // Stub the FIRST production-prisma `plan.findFirst({ where: { status:
  // 'active' }})` to return a stale snapshot pinned to `staleVersion`,
  // simulating the pre-commit view a concurrent activate exposes at READ
  // COMMITTED. The post-fix routes read the active plan via the tx client
  // (not intercepted here), so the stub never fires for them.
  async function stubStaleActivePlanRead(staleVersion: number) {
    let used = false;
    const restore = await spyOnProductionPrisma(
      'plan',
      'findFirst',
      (orig) =>
        (async (args: { where?: { status?: string } }) => {
          if (!used && args?.where?.status === 'active') {
            used = true;
            return {
              id: `stale-v${staleVersion}`,
              projectId,
              version: staleVersion,
              status: 'active',
              title: `v${staleVersion}`,
            } as never;
          }
          return (orig as (a: unknown) => unknown)(args);
        }) as never,
    );
    restorers.push(restore);
  }

  it('reactivate: guarded flip rejects when the live plan is no longer the validated `superseded` (409 STATE_CONFLICT, plan untouched)', async () => {
    // Real DB row is a DRAFT — NOT superseded. We stub the OUTER
    // requirePlanInProject read (prod prisma plan.findUnique) to report
    // 'superseded' so the L29 gate passes, mimicking a snapshot that went
    // stale before the in-tx flip. The guarded flip must observe the real
    // 'draft' status and refuse, instead of unconditionally activating it.
    const draft = await createPlan(1, 'draft');

    let used = false;
    const restore = await spyOnProductionPrisma(
      'plan',
      'findUnique',
      (orig) =>
        (async (args: { where?: { id?: string } }) => {
          if (!used && args?.where?.id === draft.id) {
            used = true;
            return { ...draft, status: 'superseded' } as never;
          }
          return (orig as (a: unknown) => unknown)(args);
        }) as never,
    );
    restorers.push(restore);

    const res = await reactivatePost(
      makeReq(`/api/projects/${projectId}/plans/${draft.id}/reactivate`, {
        method: 'POST',
        userName: owner,
      }),
      { params: Promise.resolve({ projectId, planId: draft.id }) },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('STATE_CONFLICT');

    // The draft must NOT have been resurrected to active.
    const after = await testPrisma.plan.findUnique({ where: { id: draft.id } });
    expect(after?.status).toBe('draft');
  });

  it('/rebind: binds to the in-tx active version, not the stale outer snapshot', async () => {
    await createPlan(1, 'superseded');
    await createPlan(2, 'superseded');
    await createPlan(3, 'active');
    const taskId = await createTaskBoundTo(1);

    // A concurrent activate already moved the project to v3, but the outer
    // read still sees v2 (stale). Pre-fix this binds the task to v2; post-fix
    // the in-tx read sees v3.
    await stubStaleActivePlanRead(2);

    const res = await taskRebindPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/rebind`, {
        method: 'POST',
        userName: owner,
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );

    expect(res.status).toBe(200);
    const task = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(task?.boundPlanVersion).toBe(3);
  });

  it('drift_resolve action=rebind: binds to the in-tx active version, not the stale outer snapshot', async () => {
    await createPlan(1, 'superseded');
    await createPlan(2, 'superseded');
    await createPlan(3, 'active');
    const taskId = await createTaskBoundTo(1);
    const drift = await testPrisma.driftAlert.create({
      data: {
        projectId,
        taskId,
        type: 'version_mismatch',
        severity: 'high',
        reason: 'stale-bind test',
        status: 'open',
        currentPlanVersion: 3,
        taskBoundVersion: 1,
      },
    });

    await stubStaleActivePlanRead(2);

    const res = await driftPost(
      makeReq(`/api/projects/${projectId}/drifts/${drift.id}`, {
        method: 'POST',
        userName: owner,
        body: { action: 'rebind' },
      }),
      { params: Promise.resolve({ projectId, driftId: drift.id }) },
    );

    expect(res.status).toBe(200);
    const task = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(task?.boundPlanVersion).toBe(3);
  });
});
