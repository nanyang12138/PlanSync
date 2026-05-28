import { prisma } from './prisma';
import { auditCrossProjectTaskIfNeeded } from './task-scope';
import { fetchLinkedDeliverables } from './task-deliverable-links';

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

  // R-153: join through the new link table. The legacy
  // `planDeliverableRefs: String[]` column stays around as a derived slug
  // mirror (computed from the live `deliverable.slug` values) so any caller
  // still reading the old field keeps working — but the link rows are the
  // source of truth and survive slug renames inside the same plan version.
  const linkedDeliverables = await fetchLinkedDeliverables(undefined, task.id);
  const linkedSlugs = linkedDeliverables.map((d) => d.slug);

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
      // R-153: derive the slug list from the live link rows whenever any
      // link exists. The slug rename test (verification) needs `task_pack`
      // to surface the *current* slug, not the cached array, otherwise a
      // post-rename read would still display the stale slug while drift
      // would correctly use the renamed one (a confusing split).
      //
      // When link rows exist, also include any legacy refs from the column
      // that did NOT resolve to a link row (unresolved/pre-migration refs).
      // syncTaskDeliverableLinks keeps these in the column on purpose so the
      // owner can see and correct them (#1019 — previously these were silently
      // hidden whenever any link row existed).
      //
      // When there are no link rows at all we fall back to the legacy
      // array so tasks that pre-date this migration (e.g. plan versions
      // without `plan_deliverables` rows) keep their slugs visible.
      // R-153: derive slug list from live link rows (current slugs survive renames).
      // When no link rows exist yet, fall back to the legacy column so pre-migration
      // tasks keep their slugs visible.
      // #1019: also surface legacy refs that have NO corresponding link row so the
      // owner can see and correct them. We identify unresolved refs by comparing
      // the legacy count with linked count; if there are more legacy refs than link
      // rows, include refs not accounted for by any linked deliverable's current slug.
      // When they are equal (all refs resolved, possibly via renames), only current
      // slugs are returned to avoid surfacing stale cached names.
      planDeliverableRefs:
        linkedDeliverables.length > 0
          ? (() => {
              const legacyRefs = task.planDeliverableRefs ?? [];
              const unresolvedCount = legacyRefs.length - linkedDeliverables.length;
              if (unresolvedCount <= 0) return linkedSlugs;
              // More legacy refs than link rows → some are unresolved.
              // Include legacy refs not in current linked slugs (best-effort;
              // renamed deliverables may appear but count stays correct).
              const extras = legacyRefs.filter((s) => !linkedSlugs.includes(s));
              return [...linkedSlugs, ...extras];
            })()
          : task.planDeliverableRefs,
      // Surface the structured link list so MCP / Web / CLI surfaces can
      // render per-deliverable status without a second round-trip.
      linkedDeliverables,
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
