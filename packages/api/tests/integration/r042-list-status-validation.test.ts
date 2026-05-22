// R-042: task/drift list endpoints must reject unknown status query params
// with a 400 VALIDATION_ERROR instead of silently filtering to an empty set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET as tasksGet } from '@/app/api/projects/[projectId]/tasks/route';
import { GET as driftsGet } from '@/app/api/projects/[projectId]/drifts/route';
import { makeReq, createTestProject, cleanupProject, testPrisma } from '../helpers/request';

describe('R-042: list query param zod validation', () => {
  const owner = 'r042-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));

    // Seed an active plan + one task so the "valid" assertions actually have
    // data to filter against.
    const plan = await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R-042 plan',
        goal: 'g',
        scope: 's',
        version: 1,
        status: 'active',
        createdBy: owner,
        activatedAt: new Date(),
        activatedBy: owner,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
      },
    });

    await testPrisma.task.create({
      data: {
        projectId,
        title: 'r042 task',
        type: 'code',
        priority: 'p1',
        status: 'todo',
        boundPlanVersion: plan.version,
      },
    });
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('GET /tasks?status=foo → 400 VALIDATION_ERROR', async () => {
    const res = await tasksGet(
      makeReq(`/api/projects/${projectId}/tasks`, {
        userName: owner,
        searchParams: { status: 'foo' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.some((d: { path: string }) => d.path === 'status')).toBe(true);
  });

  it('GET /tasks?status=todo (valid) → 200 with filtered results', async () => {
    const res = await tasksGet(
      makeReq(`/api/projects/${projectId}/tasks`, {
        userName: owner,
        searchParams: { status: 'todo' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    for (const t of body.data) expect(t.status).toBe('todo');
  });

  it('GET /tasks (no status filter) → 200', async () => {
    const res = await tasksGet(
      makeReq(`/api/projects/${projectId}/tasks`, { userName: owner }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
  });

  it('GET /tasks?assignee=   (whitespace only) → 400', async () => {
    const res = await tasksGet(
      makeReq(`/api/projects/${projectId}/tasks`, {
        userName: owner,
        searchParams: { assignee: '   ' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(400);
  });

  it('GET /drifts?status=foo → 400 VALIDATION_ERROR', async () => {
    const res = await driftsGet(
      makeReq(`/api/projects/${projectId}/drifts`, {
        userName: owner,
        searchParams: { status: 'foo' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.some((d: { path: string }) => d.path === 'status')).toBe(true);
  });

  it('GET /drifts?status=open (valid) → 200', async () => {
    const res = await driftsGet(
      makeReq(`/api/projects/${projectId}/drifts`, {
        userName: owner,
        searchParams: { status: 'open' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
  });
});
