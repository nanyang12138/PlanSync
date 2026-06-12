/**
 * R-210: read-only completion-state explainer endpoint.
 *
 * The DISPLAY sibling of the R-192 gate: it re-runs the pure
 * `deriveTaskCompletionState` helper and surfaces gateApplied / status /
 * missing plus driftOpen / prMerged / deliverableEvidence / outboxDeadLetters,
 * WITHOUT ever mutating a row or returning a gate error. These tests prove the
 * endpoint reports each branch faithfully against a real Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET as completionStateGet } from '@/app/api/projects/[projectId]/tasks/[taskId]/completion-state/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-210: GET /tasks/:id/completion-state', () => {
  const owner = 'r210-owner';
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

  async function makeTask(overrides: Record<string, unknown> = {}): Promise<string> {
    const t = await testPrisma.task.create({
      data: {
        projectId,
        title: 'r210 task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        boundPlanVersion: planVersion,
        agentConstraints: [],
        ...overrides,
      },
    });
    return t.id;
  }

  async function getState(taskId: string) {
    const res = await completionStateGet(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/completion-state`, {
        userName: owner,
      }),
      { params: Promise.resolve({ projectId, taskId }) },
    );
    return { res, body: await res.json() };
  }

  it('non-git project / no task wiring: gate does not apply, would-be status done', async () => {
    const taskId = await makeTask();
    const { res, body } = await getState(taskId);

    expect(res.status).toBe(200);
    expect(body.data.gateApplied).toBe(false);
    expect(body.data.status).toBe('done');
    expect(body.data.missing).toEqual([]);
    expect(body.data.driftOpen).toBe(false);
    // Not evaluated → null, never a misleading boolean.
    expect(body.data.prMerged).toBeNull();
    expect(body.data.deliverableEvidence).toBeNull();
  });

  it('open drift: driftOpen true, awaiting_evidence, pr/deliverable null (gate short-circuited)', async () => {
    const taskId = await makeTask();
    await testPrisma.driftAlert.create({
      data: {
        projectId,
        taskId,
        type: 'version_mismatch',
        severity: 'high',
        reason: 'Plan changed under this task',
        status: 'open',
        currentPlanVersion: planVersion + 1,
        taskBoundVersion: planVersion,
      },
    });

    const { body } = await getState(taskId);
    expect(body.data.driftOpen).toBe(true);
    expect(body.data.status).toBe('awaiting_evidence');
    expect(body.data.missing.map((m: { code: string }) => m.code)).toContain('drift_open');
    // Drift short-circuits stage 0 before pr/deliverable run → not evaluated.
    expect(body.data.prMerged).toBeNull();
    expect(body.data.deliverableEvidence).toBeNull();
  });

  it('git project + unmerged PR: gate applies, awaiting_evidence, prMerged false', async () => {
    await testPrisma.project.update({
      where: { id: projectId },
      data: { githubRepo: 'octo/repo' },
    });
    try {
      const taskId = await makeTask({ prUrl: 'https://github.com/octo/repo/pull/7' });
      const { body } = await getState(taskId);

      expect(body.data.gateApplied).toBe(true);
      expect(body.data.driftOpen).toBe(false);
      expect(body.data.status).toBe('awaiting_evidence');
      // No webhook ever observed this PR merged.
      expect(body.data.prMerged).toBe(false);
      expect(body.data.missing.map((m: { code: string }) => m.code)).toContain('pr_merged');
      // Task carries no deliverable refs → that check is not a requirement →
      // reported satisfied (true), not missing.
      expect(body.data.deliverableEvidence).toBe(true);
    } finally {
      // Restore so sibling tests in this describe see a non-git project.
      await testPrisma.project.update({ where: { id: projectId }, data: { githubRepo: null } });
    }
  });

  it('outboxDeadLetters reflects dead-lettered domain_events for the project', async () => {
    const taskId = await makeTask();
    const dl = await testPrisma.domainEvent.create({
      data: {
        eventType: 'github_push',
        projectId,
        payload: { type: 'github_push', projectId, data: {} },
        failedAt: new Date(),
        lastError: 'permanently broken',
      },
    });
    try {
      const { body } = await getState(taskId);
      expect(body.data.outboxDeadLetters).toBeGreaterThanOrEqual(1);
    } finally {
      await testPrisma.domainEvent.delete({ where: { id: dl.id } });
    }
  });

  it('404 for a non-existent task id', async () => {
    const { res, body } = await getState('does-not-exist');
    expect(res.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('404 (cross-project) for a task id that belongs to ANOTHER project', async () => {
    // Distinct from the non-existent-id case: here the task genuinely exists,
    // just in a different project. findFirst({ id, projectId }) must still miss
    // (projectId scope) AND this exercises the cross-project audit branch that
    // the non-existent path never reaches.
    const { projectId: otherProjectId } = await createTestProject('r210-other-owner');
    try {
      const { version: otherVersion } = await createActivePlan(otherProjectId, 'r210-other-owner');
      const otherTask = await testPrisma.task.create({
        data: {
          projectId: otherProjectId,
          title: 'task in another project',
          type: 'code',
          priority: 'p1',
          status: 'in_progress',
          boundPlanVersion: otherVersion,
          agentConstraints: [],
        },
      });

      // Query it through THIS project's id — must not leak across the boundary.
      const { res, body } = await getState(otherTask.id);
      expect(res.status).toBe(404);
      expect(body.error.code).toBe('NOT_FOUND');
    } finally {
      await cleanupProject(otherProjectId);
    }
  });
});
