import { prisma } from './prisma';

export async function buildTaskPack(taskId: string, projectId: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return null;

  const plan = await prisma.plan.findFirst({
    where: { projectId, version: task.boundPlanVersion },
  });

  const project = await prisma.project.findUnique({ where: { id: projectId } });

  const openDrifts = await prisma.driftAlert.findMany({
    where: { taskId, status: 'open' },
  });

  return {
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      type: task.type,
      priority: task.priority,
      status: task.status,
      boundPlanVersion: task.boundPlanVersion,
      branchName: task.branchName,
      prUrl: task.prUrl,
      agentContext: task.agentContext,
      expectedOutput: task.expectedOutput,
      agentConstraints: task.agentConstraints,
    },
    plan: plan
      ? {
          version: plan.version,
          title: plan.title,
          goal: plan.goal,
          scope: plan.scope,
          constraints: plan.constraints,
          standards: plan.standards,
          deliverables: plan.deliverables,
          openQuestions: plan.openQuestions,
        }
      : null,
    project: project ? { id: project.id, name: project.name, phase: project.phase } : null,
    driftAlerts: openDrifts.map((d) => ({
      id: d.id,
      severity: d.severity,
      reason: d.reason,
    })),
  };
}
