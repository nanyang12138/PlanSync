/**
 * R-140: drift gates execution via a new `Task.executionGate` column,
 * leaving `Task.status` untouched.
 *
 * Before R-140 the drift engine overwrote `task.status='blocked'` whenever
 * a plan activated and the task referenced something that changed. That
 * conflated two distinct signals:
 *
 *   - "the system is blocking new runs until the drift is resolved" —
 *     transient, cleared by drift_resolve.
 *   - "the owner / scanner determined the task itself is in a stuck
 *     lifecycle state" — sticky, status='blocked' is the owner-meaningful
 *     answer.
 *
 * The new column `executionGate ∈ {drift_high, drift_medium, manual_block,
 * null}` carries the first signal; `status` stays where the lifecycle
 * left it (todo / in_progress). This file pins the four contracts:
 *
 *   1. Plan v2 activate with a high-severity diff → task.status unchanged,
 *      executionGate='drift_high'.
 *   2. Plan v2 activate with a medium-severity diff → same shape with
 *      executionGate='drift_medium'.
 *   3. drift_resolve action=rebind → executionGate=null (and the existing
 *      R-004 reset-to-todo + supersede behaviour still holds).
 *   4. execution_start refuses to create a run while executionGate is set,
 *      returning 409 STATE_CONFLICT pointing at the drift recovery path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { POST as runsPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as driftPost } from '@/app/api/projects/[projectId]/drifts/[driftId]/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

const owner = 'r140-owner';

interface DelivSpec {
  slug: string;
  body: string;
  refUri?: string | null;
}

/**
 * R-154: severity is driven by the deliverable-id-based diff over
 * `plan_deliverables` rows linked through `task_deliverable_links`. The
 * test helper materialises that graph explicitly because the legacy
 * `Plan.deliverables: String[]` column alone no longer participates in
 * the severity calculation.
 */
async function setupTaskOnV1(opts: { v1Deliverables: DelivSpec[]; linkedSlugs: string[] }) {
  const { projectId } = await createTestProject(owner);
  const v1 = await testPrisma.plan.create({
    data: {
      projectId,
      title: 'v1',
      goal: 'g1',
      scope: 's1',
      constraints: [],
      standards: [],
      deliverables: opts.v1Deliverables.map((d) => d.body),
      openQuestions: [],
      requiredReviewers: [],
      version: 1,
      status: 'active',
      createdBy: owner,
      activatedAt: new Date(),
      activatedBy: owner,
    },
  });
  for (const d of opts.v1Deliverables) {
    await testPrisma.planDeliverable.create({
      data: {
        planId: v1.id,
        slug: d.slug,
        title: d.slug,
        body: d.body,
        refUri: d.refUri ?? null,
        status: 'active',
      },
    });
  }
  const task = await testPrisma.task.create({
    data: {
      projectId,
      title: 'gated task',
      type: 'code',
      priority: 'p1',
      status: 'in_progress',
      assignee: owner,
      assigneeType: 'human',
      boundPlanVersion: v1.version,
      planDeliverableRefs: opts.linkedSlugs,
      agentConstraints: [],
    },
  });
  if (opts.linkedSlugs.length > 0) {
    const linked = await testPrisma.planDeliverable.findMany({
      where: { planId: v1.id, slug: { in: opts.linkedSlugs } },
      select: { id: true },
    });
    for (const ld of linked) {
      await testPrisma.taskDeliverableLink.create({
        data: { taskId: task.id, deliverableId: ld.id },
      });
    }
  }
  return { projectId, taskId: task.id, v1Version: v1.version };
}

async function createAndActivateV2(projectId: string, v2Deliverables: DelivSpec[]) {
  const draft = await testPrisma.plan.create({
    data: {
      projectId,
      title: 'v2',
      goal: 'g1',
      scope: 's1',
      constraints: [],
      standards: [],
      deliverables: v2Deliverables.map((d) => d.body),
      openQuestions: [],
      requiredReviewers: [],
      version: 2,
      status: 'draft',
      createdBy: owner,
    },
  });
  for (const d of v2Deliverables) {
    await testPrisma.planDeliverable.create({
      data: {
        planId: draft.id,
        slug: d.slug,
        title: d.slug,
        body: d.body,
        refUri: d.refUri ?? null,
        status: 'active',
      },
    });
  }
  const res = await activatePost(
    makeReq(`/api/projects/${projectId}/plans/${draft.id}/activate`, {
      method: 'POST',
      userName: owner,
      body: {},
    }),
    { params: Promise.resolve({ projectId, planId: draft.id }) },
  );
  expect(res.status).toBe(200);
  return draft.id;
}

describe('R-140: drift writes executionGate, never touches task.status', () => {
  let projectId: string;
  let taskId: string;

  afterEach(async () => {
    if (projectId) await cleanupProject(projectId);
  });

  it('plan v2 activate with a breaking diff → task.status unchanged, executionGate="drift_high"', async () => {
    ({ projectId, taskId } = await setupTaskOnV1({
      v1Deliverables: [{ slug: 'rest-api', body: 'rest api spec v1' }],
      linkedSlugs: ['rest-api'],
    }));
    // v2 changes the body of the deliverable the task is linked to — R-154
    // classifies this as 'breaking'.
    await createAndActivateV2(projectId, [{ slug: 'rest-api', body: 'rest api spec v2' }]);

    const task = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(task?.executionGate).toBe('drift_high');
    // The crux of R-140: lifecycle status is NOT overwritten by drift.
    // The task was 'in_progress' when v2 activated and stays there; the
    // system gate is what tells execution_start to refuse new runs.
    expect(task?.status).toBe('in_progress');

    // And there's an open drift alert pinned to this task so the
    // surrounding UX has something to render.
    const alerts = await testPrisma.driftAlert.findMany({
      where: { projectId, taskId, status: 'open' },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('high');
  });

  it('plan v2 activate with a medium diff → executionGate="drift_medium" (status still untouched)', async () => {
    ({ projectId, taskId } = await setupTaskOnV1({
      v1Deliverables: [{ slug: 'rest-api', body: 'rest api spec', refUri: 'https://figma.com/A' }],
      linkedSlugs: ['rest-api'],
    }));
    // Only the refUri shifts; body is identical. R-154 classifies as 'medium'.
    await createAndActivateV2(projectId, [
      { slug: 'rest-api', body: 'rest api spec', refUri: 'https://figma.com/B' },
    ]);

    const task = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(task?.executionGate).toBe('drift_medium');
    expect(task?.status).toBe('in_progress');
  });

  it('execution_start on a gated task returns 409 STATE_CONFLICT with the drift hint', async () => {
    ({ projectId, taskId } = await setupTaskOnV1({
      v1Deliverables: [{ slug: 'rest-api', body: 'rest api spec v1' }],
      linkedSlugs: ['rest-api'],
    }));
    await createAndActivateV2(projectId, [{ slug: 'rest-api', body: 'rest api spec v2' }]);

    // Sanity: gate is on, status is preserved.
    const gated = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(gated?.executionGate).toBe('drift_high');

    // Force-clear the open alert to demonstrate that the gate itself —
    // not just the unresolved alert — is what blocks execution_start.
    // Without R-140 the test would only catch the drift-alert path; with
    // R-140 the column is the authoritative gate so we also need to see
    // the new branch fire.
    await testPrisma.driftAlert.updateMany({
      where: { taskId, status: 'open' },
      data: {
        status: 'resolved',
        resolvedAction: 'no_impact',
        resolvedBy: 'test-fixture',
        resolvedAt: new Date(),
      },
    });

    const startRes = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'human', executorName: owner },
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );
    expect(startRes.status).toBe(409);
    const body = await startRes.json();
    expect(body.error.code).toBe('STATE_CONFLICT');
    expect(body.error.message).toMatch(/drift_high/);
    expect(body.error.details?.executionGate).toBe('drift_high');
  });

  it('drift_resolve action=rebind clears executionGate and keeps the R-004 restart contract', async () => {
    ({ projectId, taskId } = await setupTaskOnV1({
      v1Deliverables: [{ slug: 'rest-api', body: 'rest api spec v1' }],
      linkedSlugs: ['rest-api'],
    }));
    await createAndActivateV2(projectId, [{ slug: 'rest-api', body: 'rest api spec v2' }]);

    const gated = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(gated?.executionGate).toBe('drift_high');

    const alert = await testPrisma.driftAlert.findFirst({
      where: { projectId, taskId, status: 'open' },
    });
    expect(alert).not.toBeNull();

    const res = await driftPost(
      makeReq(`/api/projects/${projectId}/drifts/${alert!.id}`, {
        method: 'POST',
        userName: owner,
        body: { action: 'rebind' },
      }),
      { params: Promise.resolve({ projectId, driftId: alert!.id }) },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.task.findUnique({ where: { id: taskId } });
    // R-140 guarantee: gate cleared.
    expect(after?.executionGate).toBeNull();
    // R-004 guarantee: rebind moves task back to 'todo' and rebinds the
    // version. We re-assert both here so a regression on either side of
    // the two-feature interaction is loud.
    expect(after?.status).toBe('todo');
    expect(after?.boundPlanVersion).toBe(2);

    // And a fresh execution_start succeeds — proving the gate clear
    // unblocked the path end-to-end.
    const startRes = await runsPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/runs`, {
        method: 'POST',
        userName: owner,
        body: { executorType: 'human', executorName: owner },
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );
    expect(startRes.status).toBe(201);
  });

  it('drift_resolve action=no_impact clears executionGate without touching status', async () => {
    ({ projectId, taskId } = await setupTaskOnV1({
      v1Deliverables: [{ slug: 'rest-api', body: 'rest api spec v1' }],
      linkedSlugs: ['rest-api'],
    }));
    await createAndActivateV2(projectId, [{ slug: 'rest-api', body: 'rest api spec v2' }]);

    const alert = await testPrisma.driftAlert.findFirst({
      where: { projectId, taskId, status: 'open' },
    });
    expect(alert).not.toBeNull();

    const res = await driftPost(
      makeReq(`/api/projects/${projectId}/drifts/${alert!.id}`, {
        method: 'POST',
        userName: owner,
        body: { action: 'no_impact' },
      }),
      { params: Promise.resolve({ projectId, driftId: alert!.id }) },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(after?.executionGate).toBeNull();
    // no_impact: status was 'in_progress' going in, stays 'in_progress'.
    // (Pre-R-140 the route would also flip status='blocked' → 'in_progress';
    // here status was never 'blocked' in the first place so the only thing
    // the resolve had to do was clear the gate.)
    expect(after?.status).toBe('in_progress');
  });

  it('drift_resolve action=cancel clears executionGate and sets status=cancelled', async () => {
    ({ projectId, taskId } = await setupTaskOnV1({
      v1Deliverables: [{ slug: 'rest-api', body: 'rest api spec v1' }],
      linkedSlugs: ['rest-api'],
    }));
    await createAndActivateV2(projectId, [{ slug: 'rest-api', body: 'rest api spec v2' }]);

    const alert = await testPrisma.driftAlert.findFirst({
      where: { projectId, taskId, status: 'open' },
    });
    expect(alert).not.toBeNull();

    const res = await driftPost(
      makeReq(`/api/projects/${projectId}/drifts/${alert!.id}`, {
        method: 'POST',
        userName: owner,
        body: { action: 'cancel' },
      }),
      { params: Promise.resolve({ projectId, driftId: alert!.id }) },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.task.findUnique({ where: { id: taskId } });
    expect(after?.executionGate).toBeNull();
    expect(after?.status).toBe('cancelled');
  });
});
