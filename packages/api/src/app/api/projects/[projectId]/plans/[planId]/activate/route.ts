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
import { requirePlanInProject } from '@/lib/plan-scope';

type Params = { params: { projectId: string; planId: string } };

/**
 * Hash a projectId string into a signed 64-bit int suitable for
 * `pg_advisory_xact_lock(bigint)`. The hash is stable and deterministic so two
 * concurrent requests for the same project always derive the same lock key.
 */
function hashProjectIdToInt64(projectId: string): bigint {
  // FNV-1a 64-bit
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask64 = (1n << 64n) - 1n;
  for (let i = 0; i < projectId.length; i++) {
    hash = (hash ^ BigInt(projectId.charCodeAt(i))) & mask64;
    hash = (hash * prime) & mask64;
  }
  // Convert unsigned 64-bit to signed for PostgreSQL bigint.
  return hash >= 1n << 63n ? hash - (1n << 64n) : hash;
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);
    await requireProjectRole(auth, params.projectId, 'owner');

    const plan = await requirePlanInProject<{
      reviews: Array<{ id: string; reviewerName: string; status: string }>;
    }>(params.planId, params.projectId, { include: { reviews: true } });

    if (plan.status !== 'draft' && plan.status !== 'proposed') {
      throw new AppError(ErrorCode.STATE_CONFLICT, 'Plan must be draft or proposed to activate');
    }

    // R-055: a 'proposed' plan with 0 reviewers must not slip through the
    // review gate. The propose flow itself permits zero reviewers (falls back
    // to plan.requiredReviewers, which may also be empty), so without this
    // check the review pathway can be bypassed entirely. Owners can still
    // override by passing ?force=true, which makes the decision auditable.
    if (plan.status === 'proposed') {
      if (plan.reviews.length === 0) {
        const force = new URL(req.url).searchParams.get('force') === 'true';
        if (!force) {
          throw new AppError(
            ErrorCode.STATE_CONFLICT,
            'Cannot activate a proposed plan with no reviewers. Owner must pass ?force=true to override.',
          );
        }
      } else {
        const allApproved = plan.reviews.every((r) => r.status === 'approved');
        if (!allApproved) {
          throw new AppError(ErrorCode.STATE_CONFLICT, 'Not all reviewers have approved');
        }
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
        // R-048: serialize concurrent activate requests per project. The
        // partial unique index (`plans_one_active_per_project`) is the final
        // safety net, but without serialization two interleaved requests can
        // both fail (deadlock / P2002 on both sides), so the user-observable
        // contract — at least one activate succeeds — is not met. Using a
        // pg_advisory_xact_lock keyed by projectId ensures the
        // updateMany→update sequence runs sequentially per project, which
        // matches the intended semantics of "activate a single plan".
        const lockKey = hashProjectIdToInt64(params.projectId);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

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
        alerts: driftAlerts.map((a) => ({
          alertId: a.id,
          taskId: a.taskId,
          severity: a.severity,
        })),
      });
      dispatchWebhooks(params.projectId, 'drift_detected', {
        alerts: driftAlerts.map((a) => ({
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
