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
import { supersedeDeliverables } from '@/lib/plan-items';

type Params = { params: Promise<{ projectId: string; planId: string }> };

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

export async function POST(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
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
    // R-055: a 'proposed' plan with 0 reviewers must not slip through the
    // review gate. New proposals auto-add the owner as reviewer (R-205) so this
    // branch is only reachable for legacy plans. To avoid AI agents inventing
    // non-existent CLI flags after reading this error, the message points
    // explicitly at the MCP tool and the HTTP query parameter — those are the
    // ONLY two paths. There is no `plansync plan activate --force` CLI
    // subcommand; `bin/plansync` is just a Terminal launcher.
    let forceUsed = false;
    if (plan.status === 'proposed') {
      if (plan.reviews.length === 0) {
        const force = new URL(req.url).searchParams.get('force') === 'true';
        if (!force) {
          throw new AppError(
            ErrorCode.STATE_CONFLICT,
            'Cannot activate a proposed plan with zero reviewers. To override, either ' +
              'call the MCP tool plansync_plan_activate with { force: true }, or send ' +
              'POST /api/projects/{projectId}/plans/{planId}/activate?force=true. ' +
              'Alternatively, withdraw the plan back to draft (plansync_plan_withdraw) and ' +
              're-propose with reviewers. There is no plansync CLI subcommand for activate.',
          );
        }
        forceUsed = true;
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

        // Closes #903 #984 — the previous activate path read
        // plan.status OUTSIDE the transaction (via
        // requirePlanInProject), then unconditionally ran
        // `tx.plan.update({ where: { id } })` here. A concurrent
        // withdraw that flipped status from 'proposed' → 'draft'
        // between the read and this update used to be silently
        // resurrected back to 'active' — the same race that #816
        // closed in the OTHER direction (withdraw losing to
        // activate). The advisory lock above serializes activate
        // calls per project, but the transactional read isolation
        // at READ COMMITTED still allows withdraw to slip in: the
        // lock only excludes other activates, not other write
        // paths.
        //
        // Mirror the withdraw fix: use updateMany scoped to
        // status: 'draft' | 'proposed' so the row only flips when
        // its state still matches what we observed. count===0
        // means a concurrent writer (almost certainly withdraw)
        // changed it; surface as STATE_CONFLICT so the operator
        // re-reads and decides explicitly.
        const flip = await tx.plan.updateMany({
          where: { id: params.planId, status: { in: ['draft', 'proposed'] } },
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
            `Concurrent state change: plan is no longer 'draft' or 'proposed' (now ` +
              `'${fresh?.status ?? 'unknown'}'). ` +
              'Re-read the plan and decide whether to re-propose / re-activate or take a different action.',
          );
        }
        // findUniqueOrThrow re-reads the post-update row so the
        // route can return the canonical activated plan + its
        // updated audit fields, byte-equivalent to the previous
        // `update`'s return value.
        const a = await tx.plan.findUniqueOrThrow({ where: { id: params.planId } });

        // R-152: link previous-version PlanDeliverable rows to the new
        // ones via supersededById (slug-matched). This must happen *after*
        // the previous active plan has been flipped to 'superseded'
        // (updateMany above) so the scoping query can find them. Idempotent
        // and safe to run on a brand-new plan with no historical chain —
        // it's a no-op when no superseded rows exist.
        await supersedeDeliverables(params.projectId, params.planId, tx);

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
      summary: `Plan v${activated.version} "${activated.title}" activated${forceUsed ? ' (force, review gate bypassed)' : ''}${driftAlerts.length > 0 ? ` (${driftAlerts.length} drift alerts)` : ''}`,
      metadata: {
        planId: activated.id,
        version: activated.version,
        driftCount: driftAlerts.length,
        forceUsed,
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
