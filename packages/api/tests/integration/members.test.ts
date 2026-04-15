// B module: Member management
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET, POST } from '@/app/api/projects/[projectId]/members/route';
import { PATCH, DELETE } from '@/app/api/projects/[projectId]/members/[memberId]/route';
import { makeReq, createTestProject, testPrisma, cleanupProject } from '../helpers/request';

describe('B: Member Management', () => {
  const owner = 'mem-owner';
  const dev = 'mem-dev';
  const dev2 = 'mem-dev2';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('B1: owner POST /members → 201', async () => {
    const res = await POST(
      makeReq(`/api/projects/${projectId}/members`, {
        method: 'POST',
        userName: owner,
        body: { name: dev, role: 'developer', type: 'human' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.name).toBe(dev);
    expect(body.data.role).toBe('developer');
  });

  it('B1边: developer POST /members → 403', async () => {
    const res = await POST(
      makeReq(`/api/projects/${projectId}/members`, {
        method: 'POST',
        userName: dev,
        body: { name: dev2, role: 'developer', type: 'human' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(403);
  });

  it('B2: 重复添加同名成员 → 409', async () => {
    const res = await POST(
      makeReq(`/api/projects/${projectId}/members`, {
        method: 'POST',
        userName: owner,
        body: { name: dev, role: 'developer', type: 'human' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
  });

  it('B3: GET /members → 200, data 数组', async () => {
    const res = await GET(makeReq(`/api/projects/${projectId}/members`, { userName: owner }), {
      params: { projectId },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('B4: owner PATCH /members/:id {role:owner}', async () => {
    const members = await testPrisma.projectMember.findMany({ where: { projectId, name: dev } });
    const memberId = members[0].id;
    const res = await PATCH(
      makeReq(`/api/projects/${projectId}/members/${memberId}`, {
        method: 'PATCH',
        userName: owner,
        body: { role: 'owner' },
      }),
      { params: { projectId, memberId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.role).toBe('owner');
    // Restore to developer for later tests
    await testPrisma.projectMember.update({ where: { id: memberId }, data: { role: 'developer' } });
  });

  it('B4边: developer PATCH /members/:id → 403', async () => {
    const members = await testPrisma.projectMember.findMany({ where: { projectId, name: owner } });
    const memberId = members[0].id;
    const res = await PATCH(
      makeReq(`/api/projects/${projectId}/members/${memberId}`, {
        method: 'PATCH',
        userName: dev,
        body: { role: 'developer' },
      }),
      { params: { projectId, memberId } },
    );
    expect(res.status).toBe(403);
  });

  it('B5: 降级唯一 owner → 400 BAD_REQUEST', async () => {
    const members = await testPrisma.projectMember.findMany({ where: { projectId, name: owner } });
    const memberId = members[0].id;
    const res = await PATCH(
      makeReq(`/api/projects/${projectId}/members/${memberId}`, {
        method: 'PATCH',
        userName: owner,
        body: { role: 'developer' },
      }),
      { params: { projectId, memberId } },
    );
    expect(res.status).toBe(400);
  });

  it('B6边: developer DELETE → 403', async () => {
    const members = await testPrisma.projectMember.findMany({ where: { projectId, name: dev } });
    const memberId = members[0].id;
    const res = await DELETE(
      makeReq(`/api/projects/${projectId}/members/${memberId}`, {
        method: 'DELETE',
        userName: dev,
      }),
      { params: { projectId, memberId } },
    );
    expect(res.status).toBe(403);
  });

  it('B7: DELETE 唯一 owner → 400', async () => {
    const members = await testPrisma.projectMember.findMany({ where: { projectId, name: owner } });
    const memberId = members[0].id;
    const res = await DELETE(
      makeReq(`/api/projects/${projectId}/members/${memberId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { projectId, memberId } },
    );
    expect(res.status).toBe(400);
  });

  it('B6: owner DELETE developer → 200', async () => {
    // Add dev2 so we have someone to delete
    await testPrisma.projectMember.create({
      data: { projectId, name: dev2, role: 'developer', type: 'human' },
    });
    const members = await testPrisma.projectMember.findMany({ where: { projectId, name: dev2 } });
    const memberId = members[0].id;
    const res = await DELETE(
      makeReq(`/api/projects/${projectId}/members/${memberId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { projectId, memberId } },
    );
    expect(res.status).toBe(200);
  });
});

describe('B-A: Member Management — Extended Coverage', () => {
  const owner = 'bxa-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('B-A1: owner can add agent-type developer', async () => {
    const res = await POST(
      makeReq(`/api/projects/${projectId}/members`, {
        method: 'POST',
        userName: owner,
        body: { name: 'bot-worker', role: 'developer', type: 'agent' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.name).toBe('bot-worker');
    expect(body.data.role).toBe('developer');
    expect(body.data.type).toBe('agent');
  });

  it('B-A2: owner can add agent-type owner', async () => {
    const res = await POST(
      makeReq(`/api/projects/${projectId}/members`, {
        method: 'POST',
        userName: owner,
        body: { name: 'bot-owner', role: 'owner', type: 'agent' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.role).toBe('owner');
    expect(body.data.type).toBe('agent');
  });

  it('B-A3: PATCH updates member type human → agent', async () => {
    const created = await testPrisma.projectMember.create({
      data: { projectId, name: 'human-to-agent', role: 'developer', type: 'human' },
    });
    const res = await PATCH(
      makeReq(`/api/projects/${projectId}/members/${created.id}`, {
        method: 'PATCH',
        userName: owner,
        body: { type: 'agent' },
      }),
      { params: { projectId, memberId: created.id } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.type).toBe('agent');
    expect(body.data.role).toBe('developer');
  });

  it('B-A4: PATCH updates both role and type simultaneously', async () => {
    const created = await testPrisma.projectMember.create({
      data: { projectId, name: 'dual-update', role: 'developer', type: 'human' },
    });
    const res = await PATCH(
      makeReq(`/api/projects/${projectId}/members/${created.id}`, {
        method: 'PATCH',
        userName: owner,
        body: { role: 'owner', type: 'agent' },
      }),
      { params: { projectId, memberId: created.id } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.role).toBe('owner');
    expect(body.data.type).toBe('agent');
  });

  it('B-A5: PATCH non-existent member → 404', async () => {
    const fakeMemberId = 'nonexistent-member-id-000';
    const res = await PATCH(
      makeReq(`/api/projects/${projectId}/members/${fakeMemberId}`, {
        method: 'PATCH',
        userName: owner,
        body: { role: 'developer' },
      }),
      { params: { projectId, memberId: fakeMemberId } },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('B-A6: DELETE non-existent member → 404', async () => {
    const fakeMemberId = 'nonexistent-member-id-001';
    const res = await DELETE(
      makeReq(`/api/projects/${projectId}/members/${fakeMemberId}`, {
        method: 'DELETE',
        userName: owner,
      }),
      { params: { projectId, memberId: fakeMemberId } },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('B-A7: can demote owner when another owner exists', async () => {
    // bot-owner was added in B-A2 (role=owner). Now add a human second-owner to demote.
    const secondOwner = await testPrisma.projectMember.create({
      data: { projectId, name: 'second-owner', role: 'owner', type: 'human' },
    });
    const res = await PATCH(
      makeReq(`/api/projects/${projectId}/members/${secondOwner.id}`, {
        method: 'PATCH',
        userName: owner,
        body: { role: 'developer' },
      }),
      { params: { projectId, memberId: secondOwner.id } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.role).toBe('developer');
  });
});
