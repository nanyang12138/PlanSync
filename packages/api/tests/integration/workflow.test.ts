import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('End-to-end Workflow', () => {
  let projectId: string;
  let planId: string;
  let taskId: string;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    if (projectId) {
      await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('should create a project with owner membership', async () => {
    const project = await prisma.$transaction(async (tx) => {
      const p = await tx.project.create({
        data: { name: `test-${Date.now()}`, phase: 'planning', createdBy: 'test-user' },
      });
      await tx.projectMember.create({
        data: { projectId: p.id, name: 'test-user', role: 'owner', type: 'human' },
      });
      return p;
    });

    projectId = project.id;
    expect(project.name).toContain('test-');
    expect(project.createdBy).toBe('test-user');

    const members = await prisma.projectMember.findMany({ where: { projectId } });
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe('owner');
  });

  it('should create a plan draft', async () => {
    const maxVersion = await prisma.plan.findFirst({
      where: { projectId },
      orderBy: { version: 'desc' },
    });

    const plan = await prisma.plan.create({
      data: {
        projectId,
        version: (maxVersion?.version ?? 0) + 1,
        status: 'draft',
        title: 'Test Plan',
        goal: 'Integration test',
        scope: 'Testing workflow',
        constraints: ['test-only'],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
        createdBy: 'test-user',
      },
    });

    planId = plan.id;
    expect(plan.status).toBe('draft');
    expect(plan.version).toBeGreaterThan(0);
  });

  it('should activate the plan', async () => {
    await prisma.plan.updateMany({
      where: { projectId, status: 'active' },
      data: { status: 'superseded' },
    });

    const activated = await prisma.plan.update({
      where: { id: planId },
      data: { status: 'active', activatedAt: new Date(), activatedBy: 'test-user' },
    });

    expect(activated.status).toBe('active');
    expect(activated.activatedBy).toBe('test-user');
  });

  it('should create a task bound to the active plan', async () => {
    const plan = await prisma.plan.findUnique({ where: { id: planId } });

    const task = await prisma.task.create({
      data: {
        projectId,
        title: 'Test task',
        type: 'code',
        priority: 'p1',
        status: 'todo',
        assigneeType: 'unassigned',
        boundPlanVersion: plan!.version,
        agentConstraints: [],
      },
    });

    taskId = task.id;
    expect(task.boundPlanVersion).toBe(plan!.version);
    expect(task.status).toBe('todo');
  });

  it('should detect drift when a new plan is activated', async () => {
    const newPlan = await prisma.plan.create({
      data: {
        projectId,
        version: 99,
        status: 'draft',
        title: 'New Plan',
        goal: 'Updated goal',
        scope: 'Updated scope',
        constraints: [],
        standards: [],
        deliverables: [],
        openQuestions: [],
        requiredReviewers: [],
        createdBy: 'test-user',
      },
    });

    await prisma.plan.updateMany({
      where: { projectId, status: 'active' },
      data: { status: 'superseded' },
    });

    await prisma.plan.update({
      where: { id: newPlan.id },
      data: { status: 'active', activatedAt: new Date(), activatedBy: 'test-user' },
    });

    const task = await prisma.task.findUnique({ where: { id: taskId } });
    expect(task!.boundPlanVersion).not.toBe(99);

    const driftAlert = await prisma.driftAlert.create({
      data: {
        projectId,
        taskId: taskId,
        type: 'version_mismatch',
        severity: 'medium',
        reason: 'Task bound to old plan version',
        status: 'open',
        currentPlanVersion: 99,
        taskBoundVersion: task!.boundPlanVersion,
      },
    });

    expect(driftAlert.status).toBe('open');
    expect(driftAlert.severity).toBe('medium');
  });

  it('should resolve drift with rebind', async () => {
    const alert = await prisma.driftAlert.findFirst({
      where: { projectId, status: 'open' },
    });

    expect(alert).not.toBeNull();

    await prisma.driftAlert.update({
      where: { id: alert!.id },
      data: { status: 'resolved', resolvedAction: 'rebind', resolvedBy: 'test-user', resolvedAt: new Date() },
    });

    await prisma.task.update({
      where: { id: taskId },
      data: { boundPlanVersion: 99 },
    });

    const task = await prisma.task.findUnique({ where: { id: taskId } });
    expect(task!.boundPlanVersion).toBe(99);

    const resolved = await prisma.driftAlert.findUnique({ where: { id: alert!.id } });
    expect(resolved!.status).toBe('resolved');
    expect(resolved!.resolvedAction).toBe('rebind');
  });
});
