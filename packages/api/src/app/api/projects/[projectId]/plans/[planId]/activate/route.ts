import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';
import { createActivity } from '@/lib/activity';
import { runDriftScan, persistDriftAlerts, enrichDriftAlertsWithAi } from '@/lib/drift-engine';
import { eventBus } from '@/lib/event-bus';
import { dispatchWebhooks } from '@/lib/webhook';
import { logger } from '@/lib/logger';

type Params = { params: { projectId: string; planId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
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

    const { activated, driftAlerts } = await prisma.$transaction(async (tx) => {
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

      return { activated: a, driftAlerts: alerts };
    });

    if (driftAlerts.length > 0) {
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
