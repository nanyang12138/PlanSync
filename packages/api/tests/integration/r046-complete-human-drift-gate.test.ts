// R-046: complete-human must reuse the runs/[runId] complete path's open-drift
// gate. Without it, a human-assigned task with an unresolved drift alert could
// be marked done by simply calling complete-human, bypassing the alignment
// check that agent executions are subject to.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as completeHumanPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/complete-human/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-046: complete-human open drift gate', () => {
  const owner = 'r046-owner';
  let projectId: string;
  let planVersion: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const { version } = await createActivePlan(projectId, owner);
    planVersion = version;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('returns 409 with DRIFT_UNRESOLVED when there is an open drift alert', async () => {
    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'Human task with open drift',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: planVersion,
        agentConstraints: [],
      },
    });

    const alert = await testPrisma.driftAlert.create({
      data: {
        projectId,
        taskId: task.id,
        type: 'version_mismatch',
        severity: 'high',
        reason: 'Plan goal changed under this task',
        status: 'open',
        currentPlanVersion: planVersion + 1,
        taskBoundVersion: planVersion,
      },
    });

    const res = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
        method: 'POST',
        userName: owner,
        body: { completionNote: 'Trying to complete despite drift' },
      }),
      { params: { projectId, taskId: task.id } },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('DRIFT_UNRESOLVED');
    expect(body.error.details.drifts).toHaveLength(1);
    expect(body.error.details.drifts[0].id).toBe(alert.id);
    expect(body.error.details.drifts[0].severity).toBe('high');

    // Task must remain not-done so a follow-up rebind or no_impact resolution
    // is still possible. Without the gate this would have transitioned to done.
    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.status).toBe('in_progress');

    // And no execution_run should have been created as a side effect of the
    // blocked call.
    const runs = await testPrisma.executionRun.count({ where: { taskId: task.id } });
    expect(runs).toBe(0);
  });

  it('succeeds when the only drift alert is already resolved', async () => {
    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'Human task with resolved drift',
        type: 'code',
        priority: 'p2',
        status: 'in_progress',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: planVersion,
        agentConstraints: [],
      },
    });

    await testPrisma.driftAlert.create({
      data: {
        projectId,
        taskId: task.id,
        type: 'version_mismatch',
        severity: 'medium',
        reason: 'Resolved noop',
        status: 'resolved',
        resolvedAction: 'no_impact',
        resolvedAt: new Date(),
        currentPlanVersion: planVersion,
        taskBoundVersion: planVersion,
      },
    });

    const res = await completeHumanPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/complete-human`, {
        method: 'POST',
        userName: owner,
        body: { completionNote: 'All good now' },
      }),
      { params: { projectId, taskId: task.id } },
    );

    expect(res.status).toBe(200);
    const refreshed = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(refreshed?.status).toBe('done');
  });
});
