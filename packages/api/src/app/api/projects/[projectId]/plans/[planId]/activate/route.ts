import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import {
  runDriftScan,
  persistDriftAlerts,
  enrichDriftAlertsWithAi,
  dispatchDriftNotifications,
} from '@/lib/drift-engine';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { logger } from '@/lib/logger';

type Params = { params: { projectId: string; planId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');

    const plan = await prisma.plan.findUnique({
      where: { id: params.planId },
      include: { reviews: true },
    });
    if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    if (plan.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    }

    if (plan.status !== 'draft' && plan.status !== 'proposed') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Plan must be draft or proposed to activate');
    }

    if (plan.status === 'proposed' && plan.reviews.length > 0) {
      const allApproved = plan.reviews.every((r) => r.status === 'approved');
      if (!allApproved) {
        throw new AppError(ErrorCode.STATE_CONFLICT, 'Not all reviewers have approved');
      }
    }

    let activated;
    let driftAlerts;
    let scannedAlerts;
    try {
      // R-007: scan and persist drift alerts inside the transaction, but defer
      // all SSE/email side-effects until after the transaction commits so that
      // a rolled-back transaction never produces "ghost" notifications.
      const result = await prisma.$transaction(async (tx) => {
        await tx.plan.updateMany({
          where: { projectId: params.projectId, status: 'active' },
          data: { status: 'superseded' },
        });

        const a = await tx.plan.update({
          where: { id: params.planId },
          data: {
            status: 'active',
            activatedAt: new Date(),
            activatedBy: auth.userName,
          },
        });

        const scanResult = await runDriftScan(tx, params.projectId, a.version);
        const alerts = await persistDriftAlerts(tx, params.projectId, scanResult.alerts);

        return { activated: a, driftAlerts: alerts, scannedAlerts: scanResult.alerts };
      });
      activated = result.activated;
      driftAlerts = result.driftAlerts;
      scannedAlerts = result.scannedAlerts;
    } catch (err) {
      // R-048: P2002 on the partial unique index
      // `plans_one_active_per_project` means another concurrent activate
      // request beat us to flipping a plan to active. Surface as 409 with a
      // helpful message rather than the generic CONFLICT mapping.
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

    // Side-effects are intentionally fired *after* the transaction has
    // committed (R-007). If the transaction had thrown, the lines below would
    // never execute and no notifications would be sent.
    if (driftAlerts.length > 0) {
      await dispatchDriftNotifications(params.projectId, scannedAlerts);
      enrichDriftAlertsWithAi(params.projectId, activated.id, driftAlerts).catch((err) =>
        logger.error({ err }, 'Background AI drift enrichment failed'),
      );
    }

    await createActivity({
      projectId: params.projectId,
      type: 'plan_activated',
      actorName: auth.userName,
      actorType: 'human',
      summary: `Plan v${activated.version} "${activated.title}" activated${driftAlerts.length > 0 ? ` (${driftAlerts.length} drift alerts)` : ''}`,
      metadata: {
        planId: activated.id,
        version: activated.version,
        driftCount: driftAlerts.length,
      },
    });

    if (driftAlerts.length > 0) {
      await createActivity({
        projectId: params.projectId,
        type: 'drift_detected',
        actorName: 'system',
        actorType: 'system',
        summary: `${driftAlerts.length} drift alert(s) detected after plan activation`,
        metadata: { alertIds: driftAlerts.map((a) => a.id) },
      });
    }

    eventBus.publish(params.projectId, 'plan_activated', {
      planId: activated.id,
      version: activated.version,
      title: activated.title,
      activatedBy: auth.userName,
    });
    dispatchWebhooks(params.projectId, 'plan_activated', {
      planId: activated.id,
      version: activated.version,
      title: activated.title,
      activatedBy: auth.userName,
    });

    if (driftAlerts.length > 0) {
      eventBus.publish(params.projectId, 'drift_detected', {
        alerts: driftAlerts.map((a: any) => ({
          alertId: a.id,
          taskId: a.taskId,
          severity: a.severity,
        })),
      });
      dispatchWebhooks(params.projectId, 'drift_detected', {
        alerts: driftAlerts.map((a: any) => ({
          alertId: a.id,
          taskId: a.taskId,
          severity: a.severity,
        })),
      });
    }

    return NextResponse.json({ data: { ...activated, driftAlerts } });
  } catch (error) {
    return handleApiError(error);
  }
}
