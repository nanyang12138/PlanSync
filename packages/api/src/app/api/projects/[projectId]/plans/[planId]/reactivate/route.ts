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

type Params = { params: { projectId: string; planId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');

    const plan = await prisma.plan.findUnique({ where: { id: params.planId } });
    if (!plan) throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    if (plan.projectId !== params.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
    }
    if (plan.status !== 'superseded') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Only superseded plans can be reactivated');
    }

    // R-052: scan and persist drift alerts inside the transaction so that if
    // persistDriftAlerts (or any later step) fails, the reactivation rolls
    // back and the project never observes "plan active but no drift alerts".
    // Side-effects (SSE, webhooks, email, AI enrichment) are deferred until
    // after the transaction commits (R-007).
    const { reactivated, driftAlerts, scannedAlerts } = await prisma.$transaction(async (tx) => {
      await tx.plan.updateMany({
        where: { projectId: params.projectId, status: 'active' },
        data: { status: 'superseded' },
      });

      const r = await tx.plan.update({
        where: { id: params.planId },
        data: {
          status: 'active',
          activatedAt: new Date(),
          activatedBy: auth.userName,
        },
      });

      const scanResult = await runDriftScan(tx, params.projectId, r.version);
      const alerts = await persistDriftAlerts(tx, params.projectId, scanResult.alerts);

      return { reactivated: r, driftAlerts: alerts, scannedAlerts: scanResult.alerts };
    });

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
    dispatchWebhooks(params.projectId, 'plan_activated', {
      planId: reactivated.id,
      version: reactivated.version,
      title: reactivated.title,
      activatedBy: auth.userName,
    });

    if (driftAlerts.length > 0) {
      await dispatchDriftNotifications(params.projectId, scannedAlerts);
      enrichDriftAlertsWithAi(params.projectId, reactivated.id, driftAlerts).catch((err) =>
        logger.error({ err }, 'Background AI drift enrichment failed'),
      );

      await createActivity({
        projectId: params.projectId,
        type: 'drift_detected',
        actorName: 'system',
        actorType: 'system',
        summary: `${driftAlerts.length} drift alert(s) detected after plan reactivation`,
        metadata: { alertIds: driftAlerts.map((a: any) => a.id) },
      });

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

    return NextResponse.json({ data: { ...reactivated, driftAlerts } });
  } catch (error) {
    return handleApiError(error);
  }
}
