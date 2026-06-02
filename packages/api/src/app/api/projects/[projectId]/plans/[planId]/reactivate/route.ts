import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { logger } from '@/lib/logger';
import {
  runDriftScan,
  persistDriftAlerts,
  enrichDriftAlertsWithAi,
  dispatchDriftNotifications,
} from '@/lib/drift-engine';
import { requirePlanInProject } from '@/lib/plan-scope';
import { supersedeDeliverables } from '@/lib/plan-items';
import { acquireProjectAdvisoryLock } from '@/lib/advisory-lock';
import { runWithRequestContext, getRequestContext } from '@/lib/request-context';

type Params = { params: Promise<{ projectId: string; planId: string }> };

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');

    const plan = await requirePlanInProject(params.planId, params.projectId);
    if (plan.status !== 'superseded') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Only superseded plans can be reactivated');
    }

    // R-052: scan and persist drift alerts inside the transaction so that if
    // persistDriftAlerts (or any later step) fails, the reactivation rolls
    // back and the project never observes "plan active but no drift alerts".
    // Side-effects (SSE, webhooks, email, AI enrichment) are deferred until
    // after the transaction commits (R-007).
    //
    // The status the outer `requirePlanInProject` read observed and that the
    // L29-31 gate validated against. The in-tx flip below is guarded against
    // this exact value so a concurrent transition (another reactivate of the
    // same row, or any write that moves it off `superseded`) surfaces as a
    // clean STATE_CONFLICT instead of silently resurrecting a stale snapshot.
    const observedStatus = plan.status;
    let reactivated;
    let driftAlerts;
    let scannedAlerts;
    try {
      const result = await prisma.$transaction(async (tx) => {
        // Mirror the activate route (R-048/R-206): serialize per-project so a
        // concurrent `plan_activate`, `execution_start`, or another
        // `reactivate` runs sequentially against the same project rather than
        // racing through READ COMMITTED and both failing on the partial unique
        // index. Acquired first so the lock-ordering is identical across every
        // route that takes it (no AB-BA deadlock).
        await acquireProjectAdvisoryLock(tx, params.projectId);

        await tx.plan.updateMany({
          where: { projectId: params.projectId, status: 'active' },
          data: { status: 'superseded' },
        });

        // Guarded flip (mirrors activate, closes #903/#984/#1167 for this
        // route): only move the row if it is STILL in the `superseded` state
        // the gate validated against. A concurrent change invalidates that
        // snapshot and we surface STATE_CONFLICT rather than unconditionally
        // forcing the row to `active`.
        const flip = await tx.plan.updateMany({
          where: { id: params.planId, status: observedStatus },
          data: {
            status: 'active',
            activatedAt: new Date(),
            activatedBy: auth.userName,
          },
        });
        if (flip.count === 0) {
          const fresh = await tx.plan.findUnique({
            where: { id: params.planId },
            select: { status: true },
          });
          throw new AppError(
            ErrorCode.STATE_CONFLICT,
            `Concurrent state change: plan was '${observedStatus}' when the reactivate ` +
              `request was validated, but is now '${fresh?.status ?? 'unknown'}'. ` +
              'Re-read the plan and decide whether to re-activate or take a different action.',
          );
        }
        const r = await tx.plan.findUniqueOrThrow({ where: { id: params.planId } });

        // R-152: same wiring the activate route does — link any older
        // (now-superseded) version's deliverables to this rollback target so
        // the chain is internally consistent regardless of which path
        // brought a plan back to `active`.
        await supersedeDeliverables(params.projectId, params.planId, tx);

        const scanResult = await runDriftScan(tx, params.projectId, r.version);
        const alerts = await persistDriftAlerts(tx, params.projectId, scanResult.alerts);

        return { reactivated: r, driftAlerts: alerts, scannedAlerts: scanResult.alerts };
      });
      reactivated = result.reactivated;
      driftAlerts = result.driftAlerts;
      scannedAlerts = result.scannedAlerts;
    } catch (err) {
      // R-048: P2002 on `plans_one_active_per_project` (or
      // `drift_alerts_one_open_per_task` in persistDriftAlerts) means a
      // concurrent activate/reactivate beat us. Surface as the same clean 409
      // STATE_CONFLICT the activate route returns rather than the generic
      // CONFLICT mapping in handleApiError.
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        throw new AppError(
          ErrorCode.STATE_CONFLICT,
          'Another plan was activated concurrently for this project. Reload and try again.',
        );
      }
      throw err;
    }

    // Snapshot the ALS context now so fire-and-forget background tasks always
    // log with this request's reqId, regardless of any concurrent enterWith
    // calls on the same async resource from subsequent requests (mirrors the
    // activate route, #302).
    const reqCtx = getRequestContext();
    const inBg = <T>(fn: () => T): T => (reqCtx ? runWithRequestContext(reqCtx, fn) : fn());

    await createActivity({
      projectId: params.projectId,
      type: 'plan_reactivated',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Plan v${reactivated.version} reactivated (rollback)`,
      metadata: { planId: reactivated.id, version: reactivated.version },
    });

    eventBus.publish(params.projectId, 'plan_activated', {
      planId: reactivated.id,
      version: reactivated.version,
      title: reactivated.title,
      activatedBy: auth.userName,
    });
    inBg(() =>
      dispatchWebhooks(params.projectId, 'plan_activated', {
        planId: reactivated.id,
        version: reactivated.version,
        title: reactivated.title,
        activatedBy: auth.userName,
      }),
    );

    if (driftAlerts.length > 0) {
      await dispatchDriftNotifications(params.projectId, scannedAlerts);
      inBg(() =>
        enrichDriftAlertsWithAi(params.projectId, reactivated.id, driftAlerts).catch((err) =>
          logger.error({ err }, 'Background AI drift enrichment failed'),
        ),
      );

      await createActivity({
        projectId: params.projectId,
        type: 'drift_detected',
        actorName: 'system',
        actorType: 'system',
        summary: `${driftAlerts.length} drift alert(s) detected after plan reactivation`,
        metadata: { alertIds: driftAlerts.map((a) => a.id) },
      });

      eventBus.publish(params.projectId, 'drift_detected', {
        alerts: driftAlerts.map((a) => ({
          alertId: a.id,
          taskId: a.taskId,
          severity: a.severity,
        })),
      });
      inBg(() =>
        dispatchWebhooks(params.projectId, 'drift_detected', {
          alerts: driftAlerts.map((a) => ({
            alertId: a.id,
            taskId: a.taskId,
            severity: a.severity,
          })),
        }),
      );
    }

    return NextResponse.json({ data: { ...reactivated, driftAlerts } });
  } catch (error) {
    return handleApiError(error);
  }
}
