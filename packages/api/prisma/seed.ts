import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  const project = await prisma.project.create({
    data: {
      name: 'PlanSync Demo',
      description: 'AI Team Collaboration Platform for Plan Alignment',
      phase: 'active',
      createdBy: 'alice',
    },
  });

  await prisma.projectMember.createMany({
    data: [
      { projectId: project.id, name: 'alice', role: 'owner', type: 'human' },
      { projectId: project.id, name: 'bob', role: 'developer', type: 'human' },
      { projectId: project.id, name: 'agent-1', role: 'developer', type: 'agent' },
    ],
  });

  const plan = await prisma.plan.create({
    data: {
      projectId: project.id,
      version: 1,
      status: 'active',
      title: 'MVP Backend Architecture',
      goal: 'Build the core API with real-time drift detection',
      scope: 'Phase 1: API + MCP Server + Drift Engine',
      constraints: ['Node.js 18', 'PostgreSQL on /tmp (NFS constraint)', 'npm workspaces'],
      standards: ['Zod validation on all inputs', 'Pino structured logging', 'Conventional commits'],
      deliverables: ['REST API', 'MCP Server with 38 tools', 'Drift Engine'],
      openQuestions: [],
      requiredReviewers: [],
      createdBy: 'alice',
      activatedAt: new Date(),
      activatedBy: 'alice',
    },
  });

  await prisma.task.createMany({
    data: [
      {
        projectId: project.id,
        title: 'Implement user authentication middleware',
        type: 'code',
        priority: 'p0',
        status: 'done',
        assignee: 'bob',
        assigneeType: 'human',
        boundPlanVersion: 1,
        agentConstraints: [],
      },
      {
        projectId: project.id,
        title: 'Build CRUD API for Projects',
        type: 'code',
        priority: 'p0',
        status: 'in_progress',
        assignee: 'agent-1',
        assigneeType: 'agent',
        boundPlanVersion: 1,
        agentConstraints: ['Use Zod for all input validation'],
      },
      {
        projectId: project.id,
        title: 'Design drift detection algorithm',
        type: 'research',
        priority: 'p1',
        status: 'todo',
        assigneeType: 'unassigned',
        boundPlanVersion: 1,
        agentConstraints: [],
      },
    ],
  });

  await prisma.activity.create({
    data: {
      projectId: project.id,
      type: 'plan_activated',
      actorName: 'alice',
      actorType: 'human',
      summary: `Plan v1 "${plan.title}" activated`,
      metadata: { planId: plan.id, version: 1 },
    },
  });

  console.log('Seed completed successfully.');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
