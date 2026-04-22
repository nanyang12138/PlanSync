// X module: Cross-Project Features Integration Tests
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';

// vi.mock is hoisted by vitest before other imports
vi.mock('@/lib/email', () => ({
  sendMail: vi.fn(),
  userEmail: (name: string) => `${name}@amd.com`,
}));

import { GET as myWorkGet } from '@/app/api/my-work/route';
import { GET as userEventsGet } from '@/app/api/user-events/route';
import { POST as proposePost } from '@/app/api/projects/[projectId]/plans/[planId]/propose/route';
import { POST as activatePost } from '@/app/api/projects/[projectId]/plans/[planId]/activate/route';
import { POST as plansPost } from '@/app/api/projects/[projectId]/plans/route';
import { POST as tasksPost } from '@/app/api/projects/[projectId]/tasks/route';
import {
  makeReq,
  createTestProject,
  addMember,
  cleanupProject,
  testPrisma,
} from '../helpers/request';
import { sendMail } from '@/lib/email';

describe('X: Cross-Project Features', () => {
  const owner = 'xp-owner';
  const reviewer = 'xp-reviewer';
  const agentUser = 'xp-agent';
  let projectAId: string;
  let projectBId: string;
  let planAId: string; // proposed plan in project A with pending review for reviewer
  let taskBId: string; // task in project B assigned to reviewer

  beforeAll(async () => {
    // Project A: owner + reviewer as human members
    ({ projectId: projectAId } = await createTestProject(owner));
    await addMember(projectAId, reviewer);

    // Project B: owner + reviewer as human members
    ({ projectId: projectBId } = await createTestProject(owner));
    await addMember(projectBId, reviewer);

    // Active plan v1 in project B (direct DB insert)
    await testPrisma.plan.create({
      data: {
        projectId: projectBId,
        title: 'Project B Active Plan',
        goal: 'goal v1',
        scope: 'scope v1',
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

    // Task in project B assigned to reviewer, bound to v1
    const task = await testPrisma.task.create({
      data: {
        projectId: projectBId,
        title: 'Cross-project reviewer task',
        type: 'code',
        priority: 'p1',
        status: 'todo',
        assignee: reviewer,
        assigneeType: 'human',
        boundPlanVersion: 1,
        agentConstraints: [],
      },
    });
    taskBId = task.id;

    // Proposed plan v1 in project A with a pending review for reviewer
    const planA = await testPrisma.plan.create({
      data: {
        projectId: projectAId,
        title: 'Project A Proposed Plan',
        goal: 'goal a',
        scope: 'scope a',
        version: 1,
        status: 'proposed',
        createdBy: owner,
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [reviewer],
      },
    });
    planAId = planA.id;

    await testPrisma.planReview.create({
      data: {
        planId: planAId,
        reviewerName: reviewer,
        status: 'pending',
      },
    });
  });

  afterAll(async () => {
    await cleanupProject(projectAId);
    await cleanupProject(projectBId);
  });

  // X1: user with no projects gets empty result
  it('X1: GET /my-work — user with no projects returns empty result', async () => {
    const res = await myWorkGet(makeReq('/api/my-work', { userName: 'x-nobody' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ reviews: [], drifts: [], tasks: [], unreadActivityCount: 0 });
  });

  // X2: pending review visible across projects
  it('X2: GET /my-work — pending review visible across projects', async () => {
    const res = await myWorkGet(makeReq('/api/my-work', { userName: reviewer }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const review = body.reviews.find((r: { planId: string }) => r.planId === planAId);
    expect(review).toBeDefined();
    expect(review.projectId).toBe(projectAId);
    expect(review.projectName).toBeTruthy();
  });

  // X3: active task visible across projects
  it('X3: GET /my-work — active task visible across projects', async () => {
    const res = await myWorkGet(makeReq('/api/my-work', { userName: reviewer }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const task = body.tasks.find((t: { id: string }) => t.id === taskBId);
    expect(task).toBeDefined();
    expect(task.projectId).toBe(projectBId);
    expect(task.projectName).toBeTruthy();
  });

  // X4: open drift alert visible across projects
  it('X4: GET /my-work — open drift alert visible across projects', async () => {
    // Insert a drift alert for reviewer's task directly in DB
    await testPrisma.driftAlert.create({
      data: {
        projectId: projectBId,
        taskId: taskBId,
        type: 'version_mismatch',
        severity: 'medium',
        reason: 'Task bound to v1, current plan is v2',
        status: 'open',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
      },
    });

    const res = await myWorkGet(makeReq('/api/my-work', { userName: reviewer }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const drift = body.drifts.find((d: { taskId: string }) => d.taskId === taskBId);
    expect(drift).toBeDefined();
    expect(drift.severity).toBe('medium');
    expect(drift.projectId).toBe(projectBId);
  });

  // X5: agent-type members are excluded from my-work
  it('X5: GET /my-work — agent-type members are excluded', async () => {
    // Add agentUser as type='agent' to project B
    await testPrisma.projectMember.create({
      data: { projectId: projectBId, name: agentUser, role: 'developer', type: 'agent' },
    });
    // Assign a task to agentUser
    await testPrisma.task.create({
      data: {
        projectId: projectBId,
        title: 'Agent-only task',
        type: 'code',
        priority: 'p2',
        status: 'todo',
        assignee: agentUser,
        assigneeType: 'agent',
        boundPlanVersion: 1,
        agentConstraints: [],
      },
    });

    // agentUser is not a human member → /my-work returns empty
    const res = await myWorkGet(makeReq('/api/my-work', { userName: agentUser }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks).toHaveLength(0);
    expect(body.reviews).toHaveLength(0);
    expect(body.drifts).toHaveLength(0);
  });

  // X6: /user-events returns 200 with text/event-stream
  it('X6: GET /user-events — 200, text/event-stream', async () => {
    const res = await userEventsGet(makeReq('/api/user-events', { userName: reviewer }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body!.cancel();
  });

  // X7: first SSE chunk is the connected comment
  it('X7: GET /user-events — first chunk is ": connected\\n\\n"', async () => {
    const res = await userEventsGet(makeReq('/api/user-events', { userName: reviewer }));
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe(': connected\n\n');
    await reader.cancel();
  });

  // X8: events received from multiple projects include projectId and projectName
  it('X8: GET /user-events — events contain projectId and projectName', async () => {
    const res = await userEventsGet(makeReq('/api/user-events', { userName: reviewer }));
    const reader = res.body!.getReader();

    // Consume the initial connected chunk
    const { value: init } = await reader.read();
    expect(new TextDecoder().decode(init)).toBe(': connected\n\n');

    // Create a task in project B (active plan v1 exists; reviewer is member)
    await tasksPost(
      makeReq(`/api/projects/${projectBId}/tasks`, {
        method: 'POST',
        userName: owner,
        body: { title: 'SSE cross-project task', type: 'code' },
      }),
      { params: { projectId: projectBId } },
    );

    // Read the event emitted to the user-events stream
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: task_created');

    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    expect(dataLine).toBeDefined();
    const data = JSON.parse(dataLine!.slice('data: '.length));
    expect(data.projectId).toBe(projectBId);
    expect(data.projectName).toBeTruthy();

    await reader.cancel();
  });

  // X9: plan propose → sendMail called with human reviewer addresses
  it('X9: plan propose → sendMail called with human reviewer email', async () => {
    vi.clearAllMocks();

    // Create a fresh draft plan in project A
    const createRes = await plansPost(
      makeReq(`/api/projects/${projectAId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'Email Test Plan',
          goal: 'email test goal',
          scope: 'email test scope',
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [],
        },
      }),
      { params: { projectId: projectAId } },
    );
    expect(createRes.status).toBe(201);
    const newPlanId = (await createRes.json()).data.id;

    // Propose with reviewer as reviewer
    const propRes = await proposePost(
      makeReq(`/api/projects/${projectAId}/plans/${newPlanId}/propose`, {
        method: 'POST',
        userName: owner,
        body: { reviewers: [reviewer] },
      }),
      { params: { projectId: projectAId, planId: newPlanId } },
    );
    expect(propRes.status).toBe(200);

    // sendMail must have been called once with reviewer's email in the recipients list
    expect(vi.mocked(sendMail)).toHaveBeenCalledTimes(1);
    const [toArg, subjectArg] = vi.mocked(sendMail).mock.calls[0];
    expect(toArg).toContain(`${reviewer}@amd.com`);
    expect(subjectArg).toContain('PlanSync');
  });

  // X9b: plan propose with agent reviewer → sendMail NOT called for agent
  it('X9b: plan propose with agent reviewer → no email sent to agent', async () => {
    vi.clearAllMocks();

    const agentReviewerName = 'xp-agent-reviewer';

    const createRes = await plansPost(
      makeReq(`/api/projects/${projectAId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'Agent Email Test Plan',
          goal: 'agent email test goal',
          scope: 'agent email test scope',
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [],
        },
      }),
      { params: { projectId: projectAId } },
    );
    expect(createRes.status).toBe(201);
    const newPlanId = (await createRes.json()).data.id;

    const propRes = await proposePost(
      makeReq(`/api/projects/${projectAId}/plans/${newPlanId}/propose`, {
        method: 'POST',
        userName: owner,
        body: { reviewers: [{ name: agentReviewerName, type: 'agent' }] },
      }),
      { params: { projectId: projectAId, planId: newPlanId } },
    );
    expect(propRes.status).toBe(200);

    const member = await testPrisma.projectMember.findUnique({
      where: { projectId_name: { projectId: projectAId, name: agentReviewerName } },
    });
    expect(member).not.toBeNull();
    expect(member?.type).toBe('agent');

    // sendMail must NOT have been called (only reviewer is an agent)
    expect(vi.mocked(sendMail)).not.toHaveBeenCalled();
  });

  // X9c: plan propose with mixed human + agent reviewers → email only to human
  it('X9c: plan propose with mixed reviewers → email only to human reviewer', async () => {
    vi.clearAllMocks();

    const mixedAgent = 'xp-mixed-agent';

    const createRes = await plansPost(
      makeReq(`/api/projects/${projectAId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'Mixed Email Test Plan',
          goal: 'mixed email goal',
          scope: 'mixed email scope',
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [],
        },
      }),
      { params: { projectId: projectAId } },
    );
    expect(createRes.status).toBe(201);
    const newPlanId = (await createRes.json()).data.id;

    const propRes = await proposePost(
      makeReq(`/api/projects/${projectAId}/plans/${newPlanId}/propose`, {
        method: 'POST',
        userName: owner,
        body: {
          reviewers: [
            reviewer, // string → defaults to human, already a member
            { name: mixedAgent, type: 'agent' },
          ],
        },
      }),
      { params: { projectId: projectAId, planId: newPlanId } },
    );
    expect(propRes.status).toBe(200);

    // sendMail should be called once, only with the human reviewer's email
    expect(vi.mocked(sendMail)).toHaveBeenCalledTimes(1);
    const [toArg] = vi.mocked(sendMail).mock.calls[0];
    expect(toArg).toContain(`${reviewer}@amd.com`);
    expect(toArg).not.toContain(`${mixedAgent}@amd.com`);
  });

  // X10: plan activate → drift alerts trigger sendMail to human task assignee
  it('X10: plan activate → drift triggers sendMail to human task assignee', async () => {
    vi.clearAllMocks();

    // Create a new draft plan v2 in project B
    const createRes = await plansPost(
      makeReq(`/api/projects/${projectBId}/plans`, {
        method: 'POST',
        userName: owner,
        body: {
          title: 'Drift Email Test Plan',
          goal: 'drift email goal',
          scope: 'drift email scope',
          constraints: [],
          standards: [],
          deliverables: [],
          openQuestions: [],
          requiredReviewers: [],
        },
      }),
      { params: { projectId: projectBId } },
    );
    expect(createRes.status).toBe(201);
    const newPlanId = (await createRes.json()).data.id;

    // Activate the new plan → drift scan runs → persistDriftAlerts → sendMail
    const actRes = await activatePost(
      makeReq(`/api/projects/${projectBId}/plans/${newPlanId}/activate`, {
        method: 'POST',
        userName: owner,
        body: {},
      }),
      { params: { projectId: projectBId, planId: newPlanId } },
    );
    expect(actRes.status).toBe(200);

    // sendMail must have been called for reviewer (the human assignee of the drifted task)
    expect(vi.mocked(sendMail)).toHaveBeenCalled();
    const allCalls = vi.mocked(sendMail).mock.calls;
    const driftCall = allCalls.find(
      ([to]) => Array.isArray(to) && to.some((addr) => addr.includes(reviewer)),
    );
    expect(driftCall).toBeDefined();
    const [, subject] = driftCall!;
    expect(subject).toContain('Drift');
  });
});
