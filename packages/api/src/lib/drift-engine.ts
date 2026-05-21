import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from './logger';
import { prisma } from './prisma';
import { aiClient } from './ai/client';
import { getOrCreatePlanDiff } from './ai/plan-diff';
import { analyzeTaskImpact } from './ai/impact-analysis';
import { eventBus } from './event-bus';
import { sendMail, userEmail } from './email';

export interface DriftScanResult {
  alerts: Array<{
    taskId: string;
    severity: 'high' | 'medium' | 'low';
    reason: string;
    currentPlanVersion: number;
    taskBoundVersion: number;
  }>;
}

export async function runDriftScan(
  tx: Prisma.TransactionClient | PrismaClient,
  projectId: string,
  newPlanVersion: number,
): Promise<DriftScanResult> {
  const tasks = await tx.task.findMany({
    where: {
      projectId,
      status: { notIn: ['cancelled'] },
      boundPlanVersion: { not: newPlanVersion },
    },
    include: {
      executionRuns: {
        where: { status: 'running' },
      },
    },
  });

  const alerts: DriftScanResult['alerts'] = [];

  for (const task of tasks) {
    const hasRunningExecution = task.executionRuns.length > 0;

    let severity: 'high' | 'medium' | 'low';
    if (hasRunningExecution) {
      severity = 'high';
    } else if (['in_progress', 'blocked', 'todo'].includes(task.status)) {
      severity = 'medium';
    } else {
      severity = 'low';
    }

    alerts.push({
      taskId: task.id,
      severity,
      reason: hasRunningExecution
        ? `Task "${task.title}" has running execution on plan v${task.boundPlanVersion}, now v${newPlanVersion}`
        : `Task "${task.title}" bound to plan v${task.boundPlanVersion}, current is v${newPlanVersion}`,
      currentPlanVersion: newPlanVersion,
      taskBoundVersion: task.boundPlanVersion,
    });
  }

  logger.info({ projectId, newPlanVersion, alertCount: alerts.length }, 'Drift scan completed');
  return { alerts };
}

export async function persistDriftAlerts(
  tx: Prisma.TransactionClient | PrismaClient,
  projectId: string,
  alerts: DriftScanResult['alerts'],
) {
  if (alerts.length === 0) return [];

  const created = await tx.driftAlert.createManyAndReturn({
    data: alerts.map((a) => ({
      projectId,
      taskId: a.taskId,
      type: 'version_mismatch',
      severity: a.severity,
      reason: a.reason,
      status: 'open',
      currentPlanVersion: a.currentPlanVersion,
      taskBoundVersion: a.taskBoundVersion,
    })),
  });

  // R-002 drift v2: when a new plan activates with high-severity drifts
  // (i.e. the task has a *currently running* run on the now-superseded plan
  // version), do two things atomically with the alert insert:
  //
  //   1. Block the task — prevents any new execution_start from racing in
  //      while the drift sits unresolved. (existing behavior)
  //
  //   2. Move the running run(s) for those tasks to status='paused'. This is
  //      the moment the API actively interrupts the agent — we no longer
  //      rely on the agent reading a `driftAlerts` array in its heartbeat
  //      response and choosing to stop. The runs/[runId] route rejects any
  //      heartbeat or complete on a paused run with 409 RUN_PAUSED; the MCP
  //      client maps that to an AbortController fire so the agent's ai-loop
  //      breaks out at the next tool call (defense in depth: SSE is
  //      best-effort, but the DB-side gate is authoritative).
  //
  // Both writes happen inside the caller's transaction, so a rollback of
  // plan-activate (rare but possible — e.g. constraint violation later in
  // the route) cleanly reverts pauses too, leaving the run as it was.
  const highSeverityTaskIds = alerts.filter((a) => a.severity === 'high').map((a) => a.taskId);
  if (highSeverityTaskIds.length > 0) {
    await tx.task.updateMany({
      where: { id: { in: highSeverityTaskIds } },
      data: { status: 'blocked' },
    });
    // Filter on status='running' so a run that the agent voluntarily
    // completed in the millisecond between drift scan and persist is left
    // alone — we only interrupt work that is actually in flight.
    await tx.executionRun.updateMany({
      where: { taskId: { in: highSeverityTaskIds }, status: 'running' },
      data: { status: 'paused' },
    });
  }

  return created;
}

/**
 * Dispatch per-assignee SSE events and notification emails for a freshly
 * persisted batch of drift alerts.
 *
 * **Always call this AFTER the enclosing `$transaction` has resolved** so a
 * rolled-back transaction does not produce "ghost" notifications (R-007).
 *
 * Note: the project-channel `drift_detected` SSE event is published by the
 * calling route (activate / reactivate), so this function only handles the
 * per-assignee personal-channel SSE and email side-effects.
 */
export async function dispatchDriftNotifications(
  projectId: string,
  alerts: DriftScanResult['alerts'],
): Promise<void> {
  if (alerts.length === 0) return;

  const taskIds = alerts.map((a) => a.taskId);
  const tasks = await prisma.task.findMany({
    where: { id: { in: taskIds }, assignee: { not: null } },
    select: { id: true, title: true, assignee: true },
  });

  const byAssignee = new Map<string, Array<{ title: string; reason: string; severity: string }>>();
  for (const alert of alerts) {
    const task = tasks.find((t) => t.id === alert.taskId);
    if (!task?.assignee) continue;
    if (!byAssignee.has(task.assignee)) byAssignee.set(task.assignee, []);
    byAssignee
      .get(task.assignee)!
      .push({ title: task.title, reason: alert.reason, severity: alert.severity });
  }

  if (byAssignee.size === 0) return;

  const assigneeNames = Array.from(byAssignee.keys());
  const humanMembers = await prisma.projectMember.findMany({
    where: { projectId, name: { in: assigneeNames }, type: 'human' },
    select: { name: true },
  });
  const humanSet = new Set(humanMembers.map((m) => m.name));

  for (const [assignee, affected] of byAssignee.entries()) {
    if (!humanSet.has(assignee)) continue;
    const lines = affected.map((a) => `  • "${a.title}": ${a.reason}`).join('\n');
    const body = [
      `The following tasks have drift alerts that require your attention:`,
      '',
      lines,
      '',
      `Please log in to PlanSync to review and resolve these drift alerts.`,
    ].join('\n');
    const ok = sendMail(
      [userEmail(assignee)],
      `[PlanSync] Drift alert: your tasks need attention`,
      body,
    );
    if (!ok) logger.warn({ assignee, projectId }, 'Failed to send drift notification email');

    // Push to the assignee's personal channel so they see the flash even if
    // they are not currently subscribed to this project's SSE stream.
    eventBus.publishToUser(assignee, 'drift_detected', projectId, {
      alerts: affected,
    });
  }
}

/**
 * Runs after drift alerts are persisted; uses AI when available to enrich
 * DriftAlert rows.
 *
 * Layout: batch DB reads, dedup plan-diffs (one AI call per unique plan pair),
 * then run per-task impact analyses in parallel. The original implementation
 * processed alerts in a serial for-loop, which made N drifts take N × AI
 * latency (5–15 s each). With N=5 the wait was ~1 minute; this version
 * collapses it to roughly one AI round-trip.
 */
export async function enrichDriftAlertsWithAi(
  projectId: string,
  activePlanId: string,
  alerts: Array<{ id: string; taskId: string }>,
): Promise<void> {
  if (!aiClient.isAvailable || alerts.length === 0) return;

  // 1. Batch-fetch tasks and the bound-plan rows they reference.
  const tasks = await prisma.task.findMany({
    where: { id: { in: alerts.map((a) => a.taskId) } },
  });
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const boundVersions = Array.from(new Set(tasks.map((t) => t.boundPlanVersion)));
  const boundPlans = boundVersions.length
    ? await prisma.plan.findMany({
        where: { projectId, version: { in: boundVersions } },
      })
    : [];
  const boundPlanByVersion = new Map(boundPlans.map((p) => [p.version, p]));

  // 2. Compute plan-diffs in parallel — one per unique (fromPlanId, toPlanId).
  // getOrCreatePlanDiff is DB-cached and tolerates the P2002 race that two
  // concurrent first-time computations of the same pair would produce.
  const uniqueDiffPairs = new Map<string, string>(); // fromPlanId → fromPlanId
  for (const plan of boundPlans) {
    if (plan.id !== activePlanId) uniqueDiffPairs.set(plan.id, plan.id);
  }
  const diffEntries = await Promise.all(
    Array.from(uniqueDiffPairs.keys()).map(async (fromPlanId) => {
      const diff = await getOrCreatePlanDiff(projectId, fromPlanId, activePlanId);
      return [fromPlanId, diff] as const;
    }),
  );
  const diffByBoundPlanId = new Map(diffEntries);

  // 3. Run impact analysis + DriftAlert update for each alert in parallel.
  // Each iteration is independent: distinct DriftAlert row, distinct AI call.
  await Promise.all(
    alerts.map(async (alert) => {
      try {
        const task = taskById.get(alert.taskId);
        if (!task) return;

        const boundPlan = boundPlanByVersion.get(task.boundPlanVersion);
        if (!boundPlan || boundPlan.id === activePlanId) return;

        const diff = diffByBoundPlanId.get(boundPlan.id);
        if (!diff) return;

        const impact = await analyzeTaskImpact(diff, task);
        if (!impact) return;

        const planDiffRow = await prisma.planDiff.findUnique({
          where: { fromPlanId_toPlanId: { fromPlanId: boundPlan.id, toPlanId: activePlanId } },
        });

        // R-001: AI is advisory only — never auto-resolve drift or unblock the
        // task. We persist the score, reasoning, suggested action and affected
        // areas so the UI/CLI can surface them as suggestions, but the human
        // (or owner) must explicitly call drift_resolve to change the alert
        // status. This prevents the agent from silently overriding plan-change
        // decisions when the heuristic compatibility score happens to be high.
        await prisma.driftAlert.update({
          where: { id: alert.id },
          data: {
            compatibilityScore: impact.compatibilityScore,
            impactAnalysis: impact.reasoning,
            suggestedAction: impact.suggestedAction,
            affectedAreas: impact.affectedAreas,
            planDiffId: planDiffRow?.id ?? null,
          },
        });
      } catch (err) {
        logger.error({ err, alertId: alert.id }, 'Failed to enrich drift alert with AI');
      }
    }),
  );
}
