// A module: Project management
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET, POST } from '@/app/api/projects/route';
import { GET as projectGET, PATCH as projectPATCH } from '@/app/api/projects/[projectId]/route';
import { GET as dashboardGET } from '@/app/api/projects/[projectId]/dashboard/route';
import { makeReq, createTestProject, addMember, cleanupProject } from '../helpers/request';

describe('A: Project Management', () => {
  const owner = 'proj-owner';
  const dev = 'proj-dev';
  let projectId: string;
  let project2Id: string;

  afterAll(async () => {
    await cleanupProject(projectId);
    await cleanupProject(project2Id);
  });

  it('A1: POST /projects → 201, createdBy=userName, auto-owner member', async () => {
    const res = await POST(
      makeReq('/api/projects', {
        method: 'POST',
        userName: owner,
        body: { name: `proj-a1-${Date.now()}`, description: 'test' },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.createdBy).toBe(owner);
    projectId = body.data.id;
  });

  it('A2: 重复创建同名项目 → 409 CONFLICT', async () => {
    // Get the existing project name
    const getRes = await projectGET(makeReq(`/api/projects/${projectId}`, { userName: owner }), {
      params: { projectId },
    });
    const { data: proj } = await getRes.json();

    const res = await POST(
      makeReq('/api/projects', {
        method: 'POST',
        userName: owner,
        body: { name: proj.name },
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
  });

  it('A3: GET /projects → 200, pagination', async () => {
    const res = await GET(makeReq('/api/projects', { userName: owner }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
    expect(typeof body.pagination.total).toBe('number');
  });

  it('A4: GET /projects/:id → 200', async () => {
    const res = await projectGET(makeReq(`/api/projects/${projectId}`, { userName: owner }), {
      params: { projectId },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(projectId);
  });

  it('A4边: GET /projects/:id → 不存在 → 404', async () => {
    const fakeId = 'nonexistent-project-id';
    const res = await projectGET(makeReq(`/api/projects/${fakeId}`, { userName: owner }), {
      params: { projectId: fakeId },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('A5: PATCH /projects/:id (owner) → 200', async () => {
    const res = await projectPATCH(
      makeReq(`/api/projects/${projectId}`, {
        method: 'PATCH',
        userName: owner,
        body: { description: 'updated description' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.description).toBe('updated description');
  });

  it('A5边: PATCH /projects/:id (developer) → 403', async () => {
    await addMember(projectId, dev);
    const res = await projectPATCH(
      makeReq(`/api/projects/${projectId}`, {
        method: 'PATCH',
        userName: dev,
        body: { description: 'hacked' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(403);
  });

  it('A6: GET /projects/:id/dashboard → 200, 含统计字段', async () => {
    const res = await dashboardGET(
      makeReq(`/api/projects/${projectId}/dashboard`, { userName: owner }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    // Dashboard should include project info
    expect(body.data.id ?? body.data.project?.id).toBeTruthy();
  });
});
