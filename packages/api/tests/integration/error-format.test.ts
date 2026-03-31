// T module: Error format consistency
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as plansPost } from '@/app/api/projects/[projectId]/plans/route';
import { GET as projectGet } from '@/app/api/projects/[projectId]/route';
import { PATCH as projectPatch } from '@/app/api/projects/[projectId]/route';
import { POST as projectsPost } from '@/app/api/projects/route';
import { PATCH as planPatch } from '@/app/api/projects/[projectId]/plans/[planId]/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as proposePost } from '@/app/api/projects/[projectId]/plans/[planId]/propose/route';
import {
  makeReq,
  createTestProject,
  addMember,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('T: Error Format Consistency', () => {
  const owner = 'err-owner';
  const dev = 'err-dev';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, dev);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('T1: missing required fields → 400, VALIDATION_ERROR with details', async () => {
    const res = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Missing fields' }, // missing goal, scope
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBeDefined();
  });

  it('T2: resource not found → 404, NOT_FOUND', async () => {
    const res = await projectGet(
      makeReq('/api/projects/nonexistent-project-id', { userName: owner }),
      { params: { projectId: 'nonexistent-project-id' } },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBeDefined();
  });

  it('T3: duplicate project name → 409, CONFLICT', async () => {
    // Get the project name
    const proj = await testPrisma.project.findUnique({ where: { id: projectId } });
    const res = await projectsPost(
      makeReq('/api/projects', {
        method: 'POST',
        userName: owner,
        body: { name: proj!.name, phase: 'planning' },
      }),
      {},
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
  });

  it('T4: invalid state transition → 409, STATE_CONFLICT', async () => {
    // Create a plan and propose it (with reviewer), then try to activate while pending
    const createRes = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'State Err Plan',
          goal: 'g',
          scope: 's',
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [],
        },
      }),
      { params: { projectId } },
    );
    const planId = (await createRes.json()).data.id;

    await proposePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/propose`, {
        method: 'POST',
        userName: owner,
        body: { reviewers: [dev] },
      }),
      { params: { projectId, planId } },
    );

    const res = await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId } },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('STATE_CONFLICT');
  });

  it('T5: developer does owner-only operation → 403, FORBIDDEN', async () => {
    const res = await projectPatch(
      makeReq(`/api/projects/${projectId}`, {
        method: 'PATCH',
        userName: dev,
        body: { name: 'Hacked' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('T6: all errors have error.code and error.message', async () => {
    const cases = [
      // 400 VALIDATION_ERROR
      plansPost(
        makeReq(`/api/projects/${projectId}/plans`, {
          method: 'POST',
          userName: owner,
          body: {},
        }),
        { params: { projectId } },
      ),
      // 404 NOT_FOUND
      projectGet(makeReq('/api/projects/no-such-id', { userName: owner }), {
        params: { projectId: 'no-such-id' },
      }),
      // 403 FORBIDDEN
      projectPatch(
        makeReq(`/api/projects/${projectId}`, {
          method: 'PATCH',
          userName: dev,
          body: { name: 'x' },
        }),
        { params: { projectId } },
      ),
    ];

    for (const p of cases) {
      const res = await p;
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
    }
  });
});
