// R-018: /api/my-work `?user=<name>` delegation
//
// Verifies that:
//   1. A project owner can query an agent's pending work via `?user=<agent>`
//      and receives that agent's tasks/drifts/reviews.
//   2. A non-owner member is forbidden from impersonating another user.
//   3. When `?user` equals the caller, behaviour is unchanged (no auth check).
//   4. The MCP `plansync_my_work` cross-project flow appends `?user=...` when
//      `agentName` is supplied (covered by URL shape — see status.ts patch).
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';

vi.mock('@/lib/email', () => ({
  sendMail: vi.fn(),
  userEmail: (name: string) => `${name}@amd.com`,
}));

import { GET as myWorkGet } from '@/app/api/my-work/route';
import {
  makeReq,
  createTestProject,
  addMember,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-018: GET /api/my-work?user=<name>', () => {
  const owner = 'r018-owner';
  const dev = 'r018-dev';
  const agent = 'r018-agent';
  const otherUser = 'r018-other';
  let projectId: string;
  let agentTaskId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, dev, 'developer');

    // Register agent as agent-type member
    await testPrisma.projectMember.create({
      data: { projectId, name: agent, role: 'developer', type: 'agent' },
    });

    // Active plan + a task assigned to the agent so /my-work has data
    await testPrisma.plan.create({
      data: {
        projectId,
        title: 'R-018 plan',
        goal: 'goal',
        scope: 'scope',
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

    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'Agent task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: agent,
        assigneeType: 'agent',
        boundPlanVersion: 1,
        agentConstraints: [],
      },
    });
    agentTaskId = task.id;

    // Open drift on the agent's task
    await testPrisma.driftAlert.create({
      data: {
        projectId,
        taskId: agentTaskId,
        type: 'version_mismatch',
        severity: 'high',
        reason: 'agent task drifted',
        status: 'open',
        currentPlanVersion: 2,
        taskBoundVersion: 1,
      },
    });
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('owner can query an agent\'s work via ?user=<agent>', async () => {
    const res = await myWorkGet(
      makeReq('/api/my-work', {
        userName: owner,
        searchParams: { user: agent },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: agentTaskId, projectId }),
      ]),
    );
    expect(body.drifts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: agentTaskId, severity: 'high' }),
      ]),
    );
    // Delegated mode always returns 0 unread (counter is per-caller, not
    // per-target) — this prevents leaking the agent's read state.
    expect(body.unreadActivityCount).toBe(0);
  });

  it('non-owner developer is forbidden from querying ?user=<other>', async () => {
    const res = await myWorkGet(
      makeReq('/api/my-work', {
        userName: dev,
        searchParams: { user: agent },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('?user equal to caller behaves the same as no ?user param', async () => {
    const a = await myWorkGet(makeReq('/api/my-work', { userName: owner }));
    const b = await myWorkGet(
      makeReq('/api/my-work', { userName: owner, searchParams: { user: owner } }),
    );
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const aBody = await a.json();
    const bBody = await b.json();
    expect(bBody.tasks.length).toBe(aBody.tasks.length);
    expect(bBody.reviews.length).toBe(aBody.reviews.length);
    expect(bBody.drifts.length).toBe(aBody.drifts.length);
  });

  it('?user pointing at someone with no shared project → 403', async () => {
    const res = await myWorkGet(
      makeReq('/api/my-work', {
        userName: owner,
        searchParams: { user: otherUser },
      }),
    );
    expect(res.status).toBe(403);
  });
});
