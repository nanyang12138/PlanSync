import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Clean existing data
  await prisma.activity.deleteMany();
  await prisma.driftAlert.deleteMany();
  await prisma.executionRun.deleteMany();
  await prisma.planComment.deleteMany();
  await prisma.planSuggestion.deleteMany();
  await prisma.planReview.deleteMany();
  await prisma.task.deleteMany();
  await prisma.plan.deleteMany();
  await prisma.projectMember.deleteMany();
  await prisma.project.deleteMany();

  // Create project
  const project = await prisma.project.create({
    data: {
      name: 'PlanSync Demo',
      description: 'AI Team Collaboration Platform for Plan Alignment — Demo Project',
      phase: 'active',
      createdBy: 'alice',
    },
  });
  console.log(`  ✓ Project "${project.name}" created`);

  // Add members
  await prisma.projectMember.createMany({
    data: [
      { projectId: project.id, name: 'alice', role: 'owner', type: 'human' },
      { projectId: project.id, name: 'bob', role: 'developer', type: 'human' },
      { projectId: project.id, name: 'coder-agent', role: 'developer', type: 'agent' },
    ],
  });
  console.log('  ✓ 3 members added (alice:owner, bob:developer, coder-agent:agent)');

  // Create Plan v1 (superseded)
  const planV1 = await prisma.plan.create({
    data: {
      projectId: project.id,
      version: 1,
      status: 'superseded',
      title: 'Initial Architecture (v1)',
      goal: 'Build basic REST API with monolithic architecture',
      scope: 'Phase 1: Monolithic API server',
      constraints: ['Node.js 18', 'Express.js', 'Single PostgreSQL DB'],
      standards: ['ESLint', 'Prettier'],
      deliverables: ['REST API', 'Basic auth'],
      openQuestions: ['Should we use GraphQL instead?'],
      requiredReviewers: [],
      createdBy: 'alice',
      activatedAt: new Date('2026-03-20'),
      activatedBy: 'alice',
    },
  });

  // Create Plan v2 (active) - demonstrates plan evolution
  const planV2 = await prisma.plan.create({
    data: {
      projectId: project.id,
      version: 2,
      status: 'active',
      title: 'MVP Backend + MCP Integration (v2)',
      goal: 'Build the core API with MCP server and real-time drift detection',
      scope: 'Phase 1: API + MCP Server + Drift Engine (npm workspaces monorepo)',
      constraints: [
        'Node.js 18',
        'PostgreSQL on /tmp (NFS constraint)',
        'npm workspaces monorepo',
        'Next.js App Router for API',
      ],
      standards: [
        'Zod validation on all API inputs',
        'Pino structured logging',
        'Conventional commits',
        'Prisma ORM with explicit field mapping',
      ],
      deliverables: [
        'REST API with ~30 endpoints',
        'MCP Server with 38 tools',
        'Drift Engine (version mismatch detection)',
        'CLI wrapper (bin/plansync)',
      ],
      openQuestions: [],
      changeSummary: 'Switched from Express to Next.js, added MCP server and drift detection',
      why: 'Need AI agent integration via MCP and real-time plan drift awareness',
      requiredReviewers: ['bob'],
      createdBy: 'alice',
      activatedAt: new Date('2026-03-25'),
      activatedBy: 'alice',
    },
  });
  console.log(`  ✓ 2 plans created (v1: superseded, v2: active)`);

  // Plan review (approved)
  await prisma.planReview.create({
    data: {
      planId: planV2.id,
      reviewerName: 'bob',
      status: 'approved',
      comment: 'Looks good. MCP integration is the right approach.',
    },
  });

  // Tasks bound to v1 (will trigger drift)
  const taskOld = await prisma.task.create({
    data: {
      projectId: project.id,
      title: 'Set up Express middleware',
      description: 'Build auth and logging middleware for Express.js',
      type: 'code',
      priority: 'p0',
      status: 'in_progress',
      assignee: 'bob',
      assigneeType: 'human',
      boundPlanVersion: 1,
      agentConstraints: [],
    },
  });

  // Tasks bound to v2 (current)
  const taskAuth = await prisma.task.create({
    data: {
      projectId: project.id,
      title: 'Implement Bearer token authentication',
      type: 'code',
      priority: 'p0',
      status: 'done',
      assignee: 'bob',
      assigneeType: 'human',
      boundPlanVersion: 2,
      agentConstraints: [],
    },
  });

  const taskApi = await prisma.task.create({
    data: {
      projectId: project.id,
      title: 'Build Project CRUD API',
      type: 'code',
      priority: 'p0',
      status: 'in_progress',
      assignee: 'coder-agent',
      assigneeType: 'agent',
      boundPlanVersion: 2,
      agentContext: 'Use Prisma ORM, follow Next.js App Router conventions',
      expectedOutput: 'GET/POST /api/projects, GET/PATCH/DELETE /api/projects/:id',
      agentConstraints: ['Zod validation on all inputs', 'Return standardized error format'],
    },
  });

  const taskDrift = await prisma.task.create({
    data: {
      projectId: project.id,
      title: 'Design drift detection algorithm',
      type: 'research',
      priority: 'p1',
      status: 'todo',
      assigneeType: 'unassigned',
      boundPlanVersion: 2,
      agentConstraints: [],
    },
  });

  const taskCancelled = await prisma.task.create({
    data: {
      projectId: project.id,
      title: 'Set up GraphQL schema',
      type: 'code',
      priority: 'p2',
      status: 'cancelled',
      assigneeType: 'unassigned',
      boundPlanVersion: 1,
      agentConstraints: [],
    },
  });
  console.log('  ✓ 5 tasks created (1 old version, 3 current, 1 cancelled)');

  // Drift alert for old task
  await prisma.driftAlert.create({
    data: {
      projectId: project.id,
      taskId: taskOld.id,
      type: 'version_mismatch',
      severity: 'medium',
      reason: `Task "Set up Express middleware" bound to plan v1, current active is v2 (switched from Express to Next.js)`,
      status: 'open',
      currentPlanVersion: 2,
      taskBoundVersion: 1,
    },
  });
  console.log('  ✓ 1 drift alert (open, medium severity)');

  // Execution run for the agent task
  await prisma.executionRun.create({
    data: {
      taskId: taskApi.id,
      executorType: 'agent',
      executorName: 'coder-agent',
      boundPlanVersion: 2,
      status: 'running',
      taskPackSnapshot: {
        task: { title: taskApi.title, type: taskApi.type },
        plan: { version: 2, title: planV2.title, goal: planV2.goal },
      },
      lastHeartbeatAt: new Date(),
      filesChanged: [],
      blockers: [],
      driftSignals: [],
    },
  });
  console.log('  ✓ 1 execution run (running)');

  // Plan suggestion
  await prisma.planSuggestion.create({
    data: {
      planId: planV2.id,
      suggestedBy: 'coder-agent',
      suggestedByType: 'agent',
      field: 'constraints',
      action: 'append',
      value: 'Use esbuild for MCP server bundling (tsc OOM on NFS)',
      reason: 'TypeScript compiler runs out of memory on NFS filesystem with MCP SDK type definitions',
      status: 'pending',
    },
  });
  console.log('  ✓ 1 plan suggestion (pending)');

  // Plan comments
  await prisma.planComment.create({
    data: {
      planId: planV2.id,
      authorName: 'alice',
      authorType: 'human',
      content: 'I like the MCP approach. Let\'s make sure we handle drift alerts properly.',
    },
  });
  await prisma.planComment.create({
    data: {
      planId: planV2.id,
      authorName: 'coder-agent',
      authorType: 'agent',
      content: 'Noted. I will check for drift alerts before starting each task execution.',
    },
  });
  console.log('  ✓ 2 plan comments');

  // Activity log
  const activities = [
    { type: 'plan_created', actorName: 'alice', actorType: 'human' as const, summary: 'Plan v1 "Initial Architecture" created' },
    { type: 'plan_activated', actorName: 'alice', actorType: 'human' as const, summary: 'Plan v1 activated' },
    { type: 'plan_created', actorName: 'alice', actorType: 'human' as const, summary: 'Plan v2 "MVP Backend + MCP" created' },
    { type: 'plan_proposed', actorName: 'alice', actorType: 'human' as const, summary: 'Plan v2 proposed for review' },
    { type: 'review_approved', actorName: 'bob', actorType: 'human' as const, summary: 'bob approved Plan v2' },
    { type: 'plan_activated', actorName: 'alice', actorType: 'human' as const, summary: 'Plan v2 activated (v1 superseded)' },
    { type: 'drift_detected', actorName: 'system', actorType: 'system' as const, summary: '1 drift alert: "Set up Express middleware" still bound to v1' },
    { type: 'task_claimed', actorName: 'coder-agent', actorType: 'agent' as const, summary: 'coder-agent claimed "Build Project CRUD API"' },
    { type: 'execution_started', actorName: 'coder-agent', actorType: 'agent' as const, summary: 'Execution started for "Build Project CRUD API"' },
    { type: 'suggestion_created', actorName: 'coder-agent', actorType: 'agent' as const, summary: 'Suggestion: append "constraints" — esbuild for MCP bundling' },
  ];

  for (const a of activities) {
    await prisma.activity.create({
      data: { projectId: project.id, ...a },
    });
  }
  console.log(`  ✓ ${activities.length} activity log entries`);

  console.log('\n========================================');
  console.log('  ✓ Seed completed!');
  console.log(`  Project ID: ${project.id}`);
  console.log('========================================');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
