import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from './logger';
import { prisma } from './prisma';
import { aiClient } from './ai/client';
import { getOrCreatePlanDiff } from './ai/plan-diff';
import { analyzeTaskImpact } from './ai/impact-analysis';
import { eventBus } from './event-bus';

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

  return tx.driftAlert.createManyAndReturn({
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
}

/** Runs after drift alerts are persisted; uses AI when available to enrich DriftAlert rows. */
export async function enrichDriftAlertsWithAi(
  projectId: string,
  activePlanId: string,
  alerts: Array<{ id: string; taskId: string }>,
): Promise<void> {
  if (!aiClient.isAvailable || alerts.length === 0) return;

  for (const alert of alerts) {
    try {
      const task = await prisma.task.findUnique({ where: { id: alert.taskId } });
      if (!task) continue;

      const boundPlan = await prisma.plan.findFirst({
        where: { projectId, version: task.boundPlanVersion },
      });
      if (!boundPlan || boundPlan.id === activePlanId) continue;

      const diff = await getOrCreatePlanDiff(projectId, boundPlan.id, activePlanId);
      if (!diff) continue;

      const impact = await analyzeTaskImpact(diff, task);
      if (!impact) continue;

      const planDiffRow = await prisma.planDiff.findUnique({
        where: { fromPlanId_toPlanId: { fromPlanId: boundPlan.id, toPlanId: activePlanId } },
      });

      const highCompatibility = impact.compatibilityScore > 70;
      const suggestedAction = highCompatibility ? 'no_impact' : impact.suggestedAction;

      await prisma.driftAlert.update({
        where: { id: alert.id },
        data: {
          compatibilityScore: impact.compatibilityScore,
          impactAnalysis: impact.reasoning,
          suggestedAction,
          affectedAreas: impact.affectedAreas,
          planDiffId: planDiffRow?.id ?? null,
          ...(highCompatibility
            ? {
                status: 'resolved',
                resolvedAction: 'no_impact',
                resolvedAt: new Date(),
                resolvedBy: 'system',
              }
            : {}),
        },
      });

      // Publish event so connected clients know the alert was auto-resolved by AI
      if (highCompatibility) {
        eventBus.publish(projectId, 'drift_resolved', {
          alertId: alert.id,
          taskId: alert.taskId,
          resolvedBy: 'system',
          resolvedAction: 'no_impact',
          compatibilityScore: impact.compatibilityScore,
        });
      }
    } catch (err) {
      logger.error({ err, alertId: alert.id }, 'Failed to enrich drift alert with AI');
    }
  }
}
