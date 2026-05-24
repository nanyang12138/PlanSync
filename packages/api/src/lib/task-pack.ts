import { prisma } from './prisma';
import { auditCrossProjectTaskIfNeeded } from './task-scope';

export async function buildTaskPack(taskId: string, projectId: string) {
  // R-135: Restrict the lookup to (id, projectId) so a caller authorized for
  // project A cannot read a task that actually lives in project B. The old
  // `findUnique({ id })` returned the row regardless of ownership and only the
  // surrounding route — when one even existed — verified the projectId match,
  // which left every direct caller (and the MCP `task_pack` tool) able to leak
  // task title / agentContext / expectedOutput / plan content across projects.
  const task = await prisma.task.findFirst({ where: { id: taskId, projectId } });
  if (!task) {
    await auditCrossProjectTaskIfNeeded(taskId, projectId, 'task_pack');
    return null;
  }

  const plan = await prisma.plan.findFirst({
    where: { projectId, version: task.boundPlanVersion },
  });

  // F2: defense-in-depth — only read the fields the pack response
  // exposes. The full row would carry `githubWebhookSecret`, and
  // task-pack is the canonical payload returned to MCP / CLI / agents.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, phase: true },
  });

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
      // R-140: surface the system gate to MCP/CLI so the banner can say
      // "blocked by drift v2" instead of inferring it from status alone.
      executionGate: task.executionGate,
      assignee: task.assignee,
      assigneeType: task.assigneeType,
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
