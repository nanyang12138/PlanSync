import { prisma } from './prisma';
import { logger } from './logger';
import { eventBus } from './event-bus';
import { dispatchWebhooks } from './webhook';
import { createActivity } from './activity';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const FAILED_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const SCAN_INTERVAL_MS = 60 * 1000; // check every 60 seconds

/**
 * How long a run may sit in `paused` before the scanner force-supersedes it.
 * Read from env on each scan so operators can tune without a restart; falls
 * back to 5 minutes. Not put through env.ts because the value is only
 * consulted here and a fully-untyped fallback keeps the global env
 * validation surface tight.
 */
function pauseAckTimeoutMs(): number {
  const raw = process.env.PLANSYNC_PAUSE_ACK_TIMEOUT_MS;
  if (!raw) return 5 * 60 * 1000;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 5 * 60 * 1000;
  return parsed;
}

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

    // R-002 follow-up: sweep paused runs that nobody ack-paused. Once the
    // drift engine moves a run to 'paused', the agent has a window to call
    // ack_pause (future) with a progress note; if that window passes the
    // run is force-superseded so it doesn't sit half-alive forever. We
    // measure the window from the latest heartbeat (heartbeat is rejected
    // with RUN_PAUSED post-pause, so the timestamp freezes within one
    // heartbeat interval of the pause). Runs that started but never
    // managed to heartbeat fall back to `startedAt`.
    const pauseTimeoutMs = pauseAckTimeoutMs();
    const pauseAckThreshold = new Date(now.getTime() - pauseTimeoutMs);
    const pausedRuns = await prisma.executionRun.findMany({
      where: {
        status: 'paused',
        OR: [
          { lastHeartbeatAt: { lt: pauseAckThreshold } },
          { AND: [{ lastHeartbeatAt: null }, { startedAt: { lt: pauseAckThreshold } }] },
        ],
      },
      include: { task: { select: { projectId: true, title: true } } },
    });

    for (const run of pausedRuns) {
      // Atomic transition with WHERE status='paused' so a concurrent
      // ack_pause path (which would itself move the run to superseded
      // with a progress note) wins the race cleanly and the scanner's
      // update simply no-ops (count===0). Not an error.
      const upd = await prisma.executionRun.updateMany({
        where: { id: run.id, status: 'paused' },
        data: {
          status: 'superseded',
          endedAt: now,
          outputSummary: `auto-superseded: pause-ack-timeout after ${pauseTimeoutMs}ms`,
        },
      });
      if (upd.count === 0) continue;

      eventBus.publish(run.task.projectId, 'execution_superseded', {
        runId: run.id,
        taskId: run.taskId,
        executorName: run.executorName,
        reason: 'pause_timeout',
        pauseTimeoutMs,
      });
      dispatchWebhooks(run.task.projectId, 'execution_superseded', {
        runId: run.id,
        taskId: run.taskId,
        executorName: run.executorName,
        reason: 'pause_timeout',
        pauseTimeoutMs,
      });
      await createActivity({
        projectId: run.task.projectId,
        type: 'execution_superseded',
        actorName: 'system',
        actorType: 'system',
        summary: `Execution on "${run.task.title}" auto-superseded (pause-ack-timeout, ${pauseTimeoutMs}ms)`,
        metadata: { runId: run.id, taskId: run.taskId, reason: 'pause_timeout' },
      });

      logger.warn(
        { runId: run.id, taskId: run.taskId, pauseTimeoutMs },
        'Paused execution force-superseded (pause-ack-timeout)',
      );
    }

    if (staleRuns.length > 0 || failedRuns.length > 0 || pausedRuns.length > 0) {
      logger.info(
        { stale: staleRuns.length, failed: failedRuns.length, pauseSwept: pausedRuns.length },
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
