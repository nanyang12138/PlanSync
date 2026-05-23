import { prisma } from './prisma';
import { logger } from './logger';
import { eventBus } from './event-bus';
import { dispatchWebhooks } from './webhook';
import { createActivity } from './activity';
import { gcExpiredMasterDelegations } from './master-audit';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const FAILED_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const SCAN_INTERVAL_MS = 60 * 1000; // check every 60 seconds

/**
 * R-056: Postgres advisory-lock key gate that ensures only one API instance
 * runs the heartbeat scan at a time. Without it, every replica scans the
 * same `paused`/`stale` rows in lockstep and emits duplicate SSE events,
 * webhook deliveries, and `execution_superseded` activity entries.
 *
 * Key layout: two-int4 form `pg_try_advisory_xact_lock(namespace, slot)`.
 *   namespace = 0x504C5359 ('PLSY') — a stable PlanSync-only namespace so
 *     we don't collide with any future advisory locks elsewhere in the
 *     codebase (or with locks set by ops tooling sharing the same DB).
 *   slot      = 1 — heartbeat scanner. Reserve subsequent slots
 *     (2, 3, ...) for other future background sweepers.
 *
 * Xact-scoped (not session-scoped) on purpose: Prisma's pooled connections
 * make session locks racey to release. Tying the lock to the surrounding
 * `$transaction` lets Postgres auto-release on commit/rollback, so even
 * an unexpected throw can never leak the slot.
 */
const ADVISORY_LOCK_NAMESPACE = 0x504c5359; // 'PLSY'
const ADVISORY_LOCK_SLOT_HEARTBEAT_SCANNER = 1;

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
    // R-056: wrap the whole scan in a single transaction so we can grab a
    // Postgres advisory lock that auto-releases on commit. If another API
    // instance is already mid-scan, pg_try_advisory_xact_lock returns false
    // and we skip this round cleanly — preventing duplicate SSE events,
    // webhook deliveries, and activity entries on multi-replica deployments.
    //
    // The transaction is intentionally short-lived: each scan touches a
    // handful of rows and finishes in well under a second on typical
    // workloads. We bump the default 5s tx timeout to 60s to leave headroom
    // for an unusually large backlog without breaking the lock.
    await prisma.$transaction(
      async (tx) => {
        const lockRows = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(
            ${ADVISORY_LOCK_NAMESPACE}::int4,
            ${ADVISORY_LOCK_SLOT_HEARTBEAT_SCANNER}::int4
          ) AS locked
        `;
        if (!lockRows[0]?.locked) {
          logger.debug(
            'Heartbeat scanner: advisory lock held by another instance, skipping this round',
          );
          return;
        }

        const failedRuns = await tx.executionRun.findMany({
          where: {
            status: 'stale',
            lastHeartbeatAt: { lt: failedThreshold },
          },
          include: { task: { select: { projectId: true, title: true } } },
        });

        for (const run of failedRuns) {
          await tx.executionRun.update({
            where: { id: run.id },
            data: { status: 'failed', endedAt: now },
          });
          logger.warn(
            { runId: run.id, taskId: run.taskId },
            'Execution marked failed (heartbeat timeout 30min)',
          );
        }

        const staleRuns = await tx.executionRun.findMany({
          where: {
            status: 'running',
            lastHeartbeatAt: { lt: staleThreshold },
          },
          include: { task: { select: { projectId: true, title: true } } },
        });

        for (const run of staleRuns) {
          await tx.executionRun.update({
            where: { id: run.id },
            data: { status: 'stale' },
          });

          // R-057: a stale run is no longer making progress, but the task
          // record still reads `in_progress` and any exec-scoped API keys
          // tied to this run remain valid — that double-misrepresents the
          // state of the world (next agent can't claim the task; abandoned
          // keys keep working). Two correctives, both bounded by the
          // surrounding tx so they commit atomically with the status flip:
          //   1. if no OTHER live (`running`/`paused`) run still exists for
          //      the same task, push the task back to `blocked` so it's
          //      visibly available for re-dispatch. The conditional
          //      `updateMany` (status in [in_progress, todo]) is on purpose:
          //      we never clobber `done`/`cancelled` and we never re-block
          //      a task that an owner has explicitly resolved.
          //   2. revoke every exec-scoped API key whose `execRunId` points
          //      at this run. The keyset is exec-mode-only (FK to the run);
          //      the row's `execRun` relation uses `onDelete: SetNull`, so
          //      hard-deleting the key is safe and audit-clean.
          const liveRuns = await tx.executionRun.count({
            where: {
              taskId: run.taskId,
              status: { in: ['running', 'paused'] },
              NOT: { id: run.id },
            },
          });
          if (liveRuns === 0) {
            await tx.task.updateMany({
              where: {
                id: run.taskId,
                status: { in: ['in_progress', 'todo'] },
              },
              data: { status: 'blocked' },
            });
          }
          const keyRevoke = await tx.apiKey.deleteMany({
            where: { execRunId: run.id },
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
            {
              runId: run.id,
              taskId: run.taskId,
              taskBlocked: liveRuns === 0,
              revokedExecKeys: keyRevoke.count,
            },
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
        const pausedRuns = await tx.executionRun.findMany({
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
          const upd = await tx.executionRun.updateMany({
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
      },
      { timeout: 60_000 },
    );
  } catch (err) {
    logger.error({ err }, 'Heartbeat scan error');
  }
}

/**
 * R-136: garbage-collect master-delegation audit rows older than the
 * retention window (default 7 days past expiry). Gated by a 10-min cadence
 * so it piggybacks on the existing 60s heartbeat tick without re-deriving
 * its own timer.
 */
const MASTER_GC_INTERVAL_MS = 10 * 60 * 1000;
let lastMasterGcAt = 0;

async function maybeGcMasterDelegations(now: number): Promise<void> {
  if (now - lastMasterGcAt < MASTER_GC_INTERVAL_MS) return;
  lastMasterGcAt = now;
  try {
    const deleted = await gcExpiredMasterDelegations(now);
    if (deleted > 0) {
      logger.info({ deleted }, 'R-136: master_delegations GC swept expired audit rows');
    }
  } catch (err) {
    // GC failure is non-fatal — the rows still exist and will be picked
    // up on the next 10-min tick. Log so it's visible in prod.
    logger.error({ err }, 'R-136: master_delegations GC failed');
  }
}

export function startHeartbeatScanner(): void {
  if (timer) return;
  timer = setInterval(async () => {
    await scanStaleExecutions();
    await maybeGcMasterDelegations(Date.now());
  }, SCAN_INTERVAL_MS);
  logger.info('Heartbeat scanner started (interval: 60s, master GC: 10min)');
}

export function stopHeartbeatScanner(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Heartbeat scanner stopped');
  }
}
