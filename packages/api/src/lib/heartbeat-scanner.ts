import { prisma } from './prisma';
import { logger } from './logger';
import { eventBus } from './event-bus';
import { dispatchWebhooks } from './webhook';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const FAILED_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const SCAN_INTERVAL_MS = 60 * 1000; // check every 60 seconds

let timer: ReturnType<typeof setInterval> | null = null;

export async function scanStaleExecutions(): Promise<void> {
  const now = new Date();

  const staleThreshold = new Date(now.getTime() - STALE_THRESHOLD_MS);
  const failedThreshold = new Date(now.getTime() - FAILED_THRESHOLD_MS);

  try {
    const failedRuns = await prisma.executionRun.findMany({
      where: {
        status: 'stale',
        lastHeartbeatAt: { lt: failedThreshold },
      },
      include: { task: { select: { projectId: true, title: true } } },
    });

    for (const run of failedRuns) {
      await prisma.executionRun.update({
        where: { id: run.id },
        data: { status: 'failed', endedAt: now },
      });
      logger.warn(
        { runId: run.id, taskId: run.taskId },
        'Execution marked failed (heartbeat timeout 30min)',
      );
    }

    const staleRuns = await prisma.executionRun.findMany({
      where: {
        status: 'running',
        lastHeartbeatAt: { lt: staleThreshold },
      },
      include: { task: { select: { projectId: true, title: true } } },
    });

    for (const run of staleRuns) {
      await prisma.executionRun.update({
        where: { id: run.id },
        data: { status: 'stale' },
      });

      eventBus.publish(run.task.projectId, 'execution_stale', {
        runId: run.id,
        taskId: run.taskId,
        executorName: run.executorName,
        lastHeartbeatAt: run.lastHeartbeatAt?.toISOString(),
      });
      dispatchWebhooks(run.task.projectId, 'execution_stale', {
        runId: run.id,
        taskId: run.taskId,
        executorName: run.executorName,
        lastHeartbeatAt: run.lastHeartbeatAt?.toISOString(),
      });

      logger.warn(
        { runId: run.id, taskId: run.taskId },
        'Execution marked stale (heartbeat timeout 5min)',
      );
    }

    if (staleRuns.length > 0 || failedRuns.length > 0) {
      logger.info(
        { stale: staleRuns.length, failed: failedRuns.length },
        'Heartbeat scan completed',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Heartbeat scan error');
  }
}

export function startHeartbeatScanner(): void {
  if (timer) return;
  timer = setInterval(scanStaleExecutions, SCAN_INTERVAL_MS);
  logger.info('Heartbeat scanner started (interval: 60s)');
}

export function stopHeartbeatScanner(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Heartbeat scanner stopped');
  }
}
