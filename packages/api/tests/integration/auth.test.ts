// S module: Auth
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET as projectGet } from '@/app/api/projects/[projectId]/route';
import { GET as membersGet } from '@/app/api/projects/[projectId]/members/route';
import { POST as membersPost } from '@/app/api/projects/[projectId]/members/route';
import { makeReq, createTestProject, addMember, cleanupProject } from '../helpers/request';

describe('S: Authentication & Authorization', () => {
  const owner = 'auth-owner';
  const dev = 'auth-dev';
  const outsider = 'auth-outsider';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, dev);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('S5: AUTH_DISABLED=true, only x-user-name header → 200', async () => {
    // AUTH_DISABLED=true is set in setup.ts, so just x-user-name should work
    const res = await projectGet(makeReq(`/api/projects/${projectId}`, { userName: owner }), {
      params: { projectId },
    });
    expect(res.status).toBe(200);
  });

  it('S1: Bearer PLANSYNC_SECRET + x-user-name → 200', async () => {
    const secret = process.env.PLANSYNC_SECRET || 'test-secret';
    const res = await projectGet(
      makeReq(`/api/projects/${projectId}`, {
        userName: owner,
        authToken: secret,
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
  });

  it('S7: non-member accesses project → 403', async () => {
    const res = await projectGet(makeReq(`/api/projects/${projectId}`, { userName: outsider }), {
      params: { projectId },
    });
    expect(res.status).toBe(403);
  });

  it('S8: developer tries owner-only operation → 403', async () => {
    const res = await membersPost(
      makeReq(`/api/projects/${projectId}/members`, {
        method: 'POST',
        userName: dev,
        body: { name: 'new-person', role: 'developer', type: 'human' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(403);
  });

  it('S10: Alice is member → 200', async () => {
    const res = await membersGet(
      makeReq(`/api/projects/${projectId}/members`, { userName: owner }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
  });

  it('S11: Bob is not member → 403', async () => {
    const res = await membersGet(
      makeReq(`/api/projects/${projectId}/members`, { userName: 'not-bob-not-member' }),
      { params: { projectId } },
    );
    expect(res.status).toBe(403);
  });
});
