import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from './logger';

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
