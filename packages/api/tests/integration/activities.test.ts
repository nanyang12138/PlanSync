// Q module: Activity log
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET as activitiesGet } from '@/app/api/projects/[projectId]/activities/route';
import { POST as plansPost } from '@/app/api/projects/[projectId]/plans/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as tasksPost } from '@/app/api/projects/[projectId]/tasks/route';
import { POST as claimPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/claim/route';
import { POST as declinePost } from '@/app/api/projects/[projectId]/tasks/[taskId]/decline/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('Q: Activity Log', () => {
  const owner = 'activity-owner';
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await createActivePlan(projectId, owner);
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('Q4: GET /activities → 200, data array', async () => {
    const res = await activitiesGet(
      makeReq(`/api/projects/${projectId}/activities`, { userName: owner }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('Q1: create plan → activity type=plan_created', async () => {
    await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'Activity Plan',
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

    const activities = await testPrisma.activity.findMany({
      where: { projectId, type: 'plan_created' },
    });
    expect(activities.length).toBeGreaterThan(0);
  });

  it('Q1: activate plan → activity type=plan_activated', async () => {
    const createRes = await plansPost(
      makeReq(`/api/projects/${projectId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'Activate Plan',
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

    await activatePost(
      makeReq(`/api/projects/${projectId}/plans/${planId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, planId } },
    );

    const activities = await testPrisma.activity.findMany({
      where: { projectId, type: 'plan_activated' },
    });
    expect(activities.length).toBeGreaterThan(0);
  });

  it('Q2: create task → activity type=task_created', async () => {
    await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Activity Task', type: 'code' },
      }),
      { params: { projectId } },
    );

    const activities = await testPrisma.activity.findMany({
      where: { projectId, type: 'task_created' },
    });
    expect(activities.length).toBeGreaterThan(0);
  });

  it('Q2.1: decline task → activity type=task_declined', async () => {
    const taskRes = await tasksPost(
      makeReq(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'Decline Activity Task', type: 'code' },
      }),
      { params: { projectId } },
    );
    const taskId = (await taskRes.json()).data.id;

    // Claim with startImmediately=false
    await claimPost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/claim`, {
        method: 'POST',
        userName: owner,
        body: { startImmediately: false, assigneeType: 'human' },
      }),
      { params: { projectId, taskId } },
    );

    await declinePost(
      makeReq(`/api/projects/${projectId}/tasks/${taskId}/decline`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId, taskId } },
    );

    const activities = await testPrisma.activity.findMany({
      where: { projectId, type: 'task_declined' },
    });
    expect(activities.length).toBeGreaterThan(0);
  });

  it('Q5: GET /activities?pageSize=2 → at most 2 items', async () => {
    const res = await activitiesGet(
      makeReq(`/api/projects/${projectId}/activities`, {
        userName: owner,
        searchParams: { pageSize: '2' },
      }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeLessThanOrEqual(2);
  });

  it('Q6: human operation → actorType=human', async () => {
    const activities = await testPrisma.activity.findMany({
      where: { projectId, actorType: 'human' },
      take: 1,
    });
    expect(activities.length).toBeGreaterThan(0);
    expect(activities[0].actorType).toBe('human');
  });

  it('Q7: activity has required fields', async () => {
    const activity = await testPrisma.activity.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    expect(activity).not.toBeNull();
    expect(activity?.type).toBeDefined();
    expect(activity?.actorName).toBeDefined();
    expect(activity?.summary).toBeDefined();
  });
});
