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
let currentScan: Promise<void> | null = null;

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

          // R-108: the 30-min sweep is the only place a run flips from
          // `stale` to terminal `failed`. Without an activity row the
          // owner-facing feed shows execution_started → execution_stale
          // and then the run silently disappears from the active board,
          // matching the audit gap R-104/R-105/R-106/R-107 closed for
          // other terminal transitions.
          //
          // Closes #759: createActivity uses the global `prisma` client
          // (not the surrounding `tx`), but a thrown error from inside
          // this async callback still rolls back the entire scanner
          // transaction — including the just-applied heartbeat-timeout
          // status flips. Wrap in best-effort try/catch so a transient
          // audit-write failure logs and continues; the status flip
          // remains authoritative.
          try {
            await createActivity({
              projectId: run.task.projectId,
              type: 'execution_failed',
              actorName: 'system',
              actorType: 'system',
              summary: `Execution on "${run.task.title}" marked failed (heartbeat timeout 30min)`,
              metadata: {
                runId: run.id,
                taskId: run.taskId,
                executorName: run.executorName,
                reason: 'heartbeat_timeout_failed',
                thresholdMs: FAILED_THRESHOLD_MS,
                lastHeartbeatAt: run.lastHeartbeatAt?.toISOString() ?? null,
              },
            });
          } catch (err) {
            logger.warn(
              { err, runId: run.id, taskId: run.taskId, type: 'execution_failed' },
              'heartbeat-scanner: audit write failed; status flip preserved',
            );
          }

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

          // R-057: a stale run leaves the task in `in_progress` and its
          // exec-scoped API key still active — owner sees a phantom "this
          // task is being worked on" forever, and a crashed agent's key
          // remains a usable foothold until the 30-min `failed` sweep
          // happens (and even then, the key was never being cleaned up at
          // all). Both pieces of state are owned by this run and become
          // meaningless the moment it goes stale, so release them in the
          // same transaction the status flip happens in.
          //
          // The task flip is guarded by "no other running run for the same
          // task" — mirroring the same guard the /complete failed path uses
          // (route runs/[runId]/route.ts) — so a parallel re-execution that
          // started after this scan's findMany doesn't get clobbered into
          // blocked. We count `status='running'` excluding this row; this
          // run itself was just moved to `stale` inside the same tx so
          // it's already excluded by the where clause, but the explicit
          // `id: { not: run.id }` keeps the intent obvious for readers and
          // is robust to a future refactor that moves the status flip.
          const otherRunningCount = await tx.executionRun.count({
            where: {
              taskId: run.taskId,
              status: 'running',
              id: { not: run.id },
            },
          });
          // Closes #760: the `taskBlocked` metadata recorded below was
          // previously derived solely from `otherRunningCount === 0`.
          // That over-claims when the task was already in some status
          // other than `in_progress` (e.g. `blocked`, `completed`,
          // `cancelled` from a prior sweep) — `updateMany` returns
          // count=0, the task is NOT blocked by us, but the metadata
          // still said `taskBlocked: true`. Use the actual updateMany
          // count to record only what this sweep changed.
          let taskBlockedByThisSweep = false;
          if (otherRunningCount === 0) {
            const taskFlip = await tx.task.updateMany({
              where: { id: run.taskId, status: 'in_progress' },
              data: { status: 'blocked' },
            });
            taskBlockedByThisSweep = taskFlip.count > 0;
          }

          // R-057: the matching exec-scoped API key is identified by
          // `execRunId`. deleteMany is idempotent (a re-scan of a row that
          // already had its key cleaned up no-ops at count=0) and covers
          // the case where issue-token created multiple sibling keys for
          // the same run.
          const keyDelete = await tx.apiKey.deleteMany({
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

          // R-108: matching record for the 5-min stale flip. Includes
          // whether the task itself was demoted to `blocked` and how
          // many exec-scoped keys were revoked, so an owner reading the
          // audit feed can reconstruct R-057's side effects without
          // cross-referencing the API key table.
          // Closes #759 — best-effort audit write so a transient PG
          // hiccup cannot roll back the scanner's status flips.
          try {
            await createActivity({
              projectId: run.task.projectId,
              type: 'execution_stale',
              actorName: 'system',
              actorType: 'system',
              summary: `Execution on "${run.task.title}" marked stale (heartbeat timeout 5min)`,
              metadata: {
                runId: run.id,
                taskId: run.taskId,
                executorName: run.executorName,
                reason: 'heartbeat_timeout_stale',
                thresholdMs: STALE_THRESHOLD_MS,
                lastHeartbeatAt: run.lastHeartbeatAt?.toISOString() ?? null,
                // Closes #760: `taskBlocked` reflects what THIS sweep
                // actually changed (updateMany.count > 0), not the
                // pre-update intent.
                taskBlocked: taskBlockedByThisSweep,
                execKeysRevoked: keyDelete.count,
              },
            });
          } catch (err) {
            logger.warn(
              { err, runId: run.id, taskId: run.taskId, type: 'execution_stale' },
              'heartbeat-scanner: audit write failed; status flip preserved',
            );
          }

          logger.warn(
            {
              runId: run.id,
              taskId: run.taskId,
              taskBlocked: taskBlockedByThisSweep,
              execKeysRevoked: keyDelete.count,
            },
            'Execution marked stale (heartbeat timeout 5min); task + exec key released',
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
          // Closes #759 — same best-effort wrapper as the failed/stale
          // branches; an audit-write failure must not roll back the
          // status flip we just committed.
          try {
            await createActivity({
              projectId: run.task.projectId,
              type: 'execution_superseded',
              actorName: 'system',
              actorType: 'system',
              summary: `Execution on "${run.task.title}" auto-superseded (pause-ack-timeout, ${pauseTimeoutMs}ms)`,
              metadata: { runId: run.id, taskId: run.taskId, reason: 'pause_timeout' },
            });
          } catch (err) {
            logger.warn(
              { err, runId: run.id, taskId: run.taskId, type: 'execution_superseded' },
              'heartbeat-scanner: audit write failed; status flip preserved',
            );
          }

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
  timer = setInterval(() => {
    currentScan = (async () => {
      await scanStaleExecutions();
      await maybeGcMasterDelegations(Date.now());
    })().finally(() => {
      currentScan = null;
    });
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

/**
 * Resolves when any in-progress scan cycle completes. Call after
 * `stopHeartbeatScanner()` so the SIGTERM drain can wait for the
 * active transaction to commit before process.exit fires (#233/#267/#275).
 */
export async function flushHeartbeatScanner(): Promise<void> {
  if (currentScan) await currentScan;
}
