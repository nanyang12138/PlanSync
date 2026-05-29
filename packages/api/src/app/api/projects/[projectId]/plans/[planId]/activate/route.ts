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
import { runWithRequestContext, getRequestContext } from '@/lib/request-context';
import { requirePlanInProject } from '@/lib/plan-scope';
import { supersedeDeliverables } from '@/lib/plan-items';
import { acquireProjectAdvisoryLock } from '@/lib/advisory-lock';

type Params = { params: Promise<{ projectId: string; planId: string }> };

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
        //
        // R-206: the same advisory lock is also acquired by
        // `execution_start` (POST /tasks/:id/runs) so that route serializes
        // against in-flight activates and observes the committed
        // `task.executionGate` rather than racing past it. Both routes MUST
        // use the same key derivation (see `acquireProjectAdvisoryLock`)
        // for the exclusion to actually take effect.
        await acquireProjectAdvisoryLock(tx, params.projectId);

        await tx.plan.updateMany({
          where: { projectId: params.projectId, status: 'active' },
          data: { status: 'superseded' },
        });

        // Closes #903 #984 #1167 — the previous activate path read
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
        // First-pass fix (#903 #984) used `status: { in: ['draft',
        // 'proposed'] }` as the in-tx guard. That tightened the
        // 'proposed → superseded' race but, as #1167 pointed out,
        // STILL allowed the concrete withdraw race the fix
        // claimed to close: outer read sees 'proposed', passes the
        // review gate (L67–L87), concurrent withdraw flips it to
        // 'draft' (and deletes PlanReview rows), the in-tx
        // updateMany matches the now-'draft' row and silently
        // activates a plan whose review-gate evaluation is now
        // stale. The 'force=true' branch is even worse: a
        // proposed-with-zero-reviewers row that got withdrawn
        // would be activated without re-reading the review state.
        //
        // Tighten the guard to the EXACT status we observed and
        // gated against at L50–L87 (`plan.status`, the snapshot
        // from requirePlanInProject). The in-tx update only flips
        // a row whose state is STILL identical to what passed the
        // review gate, which is the strongest invariant we can
        // assert without re-running the gate inside the tx.
        // Any mid-flight transition — proposed→draft (withdraw),
        // draft→proposed (propose), proposed→active/superseded
        // (concurrent activate), etc. — invalidates the
        // pre-validated snapshot and surfaces as STATE_CONFLICT
        // so the operator re-reads and decides explicitly.
        const observedStatus = plan.status;

        // Closes #1642 — the status-only in-tx guard below is necessary
        // but not sufficient. Both reviewer-add paths
        // (POST .../plans/[planId]/reviews and
        // PATCH .../plans/[planId] with `requiredReviewers`) create a
        // new pending PlanReview WITHOUT changing plan.status. If one
        // of them lands between the outer review-gate (L67–L87,
        // evaluated against the outer-read snapshot `plan.reviews`)
        // and the flip below, the status guard still matches
        // ('proposed' === 'proposed') and the route silently
        // activates a plan whose review set just gained a pending
        // reviewer who never approved.
        //
        // Re-validate the review gate INSIDE the transaction. First
        // acquire `FOR UPDATE` on the plan row: both reviewer-add
        // paths write `plan` in the same tx as their `planReview`
        // write (POST: `plan.update({ requiredReviewers: { push } })`;
        // PATCH: scalar `plan.update` before `planReview.createMany`),
        // so taking the row lock here forces any in-flight
        // reviewer-add to either commit before our re-read (then we
        // see the new pending row and 409) or after our tx releases
        // (then it lost the race and our activate is correct against
        // the state we observed). The status-only `updateMany` below
        // is kept as a defense-in-depth check, but the review-set
        // re-validation is the one that actually closes #1642.
        await tx.$executeRaw`SELECT id FROM "plans" WHERE id = ${params.planId} FOR UPDATE`;

        if (observedStatus === 'proposed') {
          const txReviews = await tx.planReview.findMany({
            where: { planId: params.planId },
            select: { status: true },
          });
          if (forceUsed) {
            // Outer gate was bypassed via ?force=true because reviews
            // were empty at outer-read time. If reviewers were added
            // concurrently, force can no longer apply — the operator
            // must observe the new reviewer set and decide explicitly
            // (re-issue force, or wait for approvals).
            if (txReviews.length !== 0) {
              throw new AppError(
                ErrorCode.STATE_CONFLICT,
                `Concurrent reviewer change: activate was validated with 0 reviewers ` +
                  `(force=true), but the plan now has ${txReviews.length} reviewer(s). ` +
                  `Re-read the plan and either wait for the new reviewer(s) to approve or re-issue activate.`,
              );
            }
          } else {
            // Outer gate passed because all reviews at outer-read time
            // were approved. If a new pending/rejected review snuck in,
            // the gate is now stale; reject.
            const allApproved =
              txReviews.length > 0 && txReviews.every((r) => r.status === 'approved');
            if (!allApproved) {
              const outerCount = plan.reviews.length;
              const txTotal = txReviews.length;
              const txPending = txReviews.filter((r) => r.status !== 'approved').length;
              throw new AppError(
                ErrorCode.STATE_CONFLICT,
                `Concurrent reviewer change: the review gate was validated with ` +
                  `${outerCount} approved reviewer(s), but the plan now has ` +
                  `${txTotal} reviewer(s) (${txPending} not yet approved). ` +
                  `Re-read the plan and either wait for the new reviewer(s) to approve or re-issue activate.`,
              );
            }
          }
        }

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
            `Concurrent state change: plan was '${observedStatus}' when the activate ` +
              `request was validated, but is now '${fresh?.status ?? 'unknown'}'. ` +
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
    //
    // Snapshot the ALS context now so fire-and-forget background tasks always
    // log with this request's reqId, regardless of any concurrent enterWith
    // calls on the same async resource from subsequent requests.
    const reqCtx = getRequestContext();
    const inBg = <T>(fn: () => T): T => (reqCtx ? runWithRequestContext(reqCtx, fn) : fn());

    if (driftAlerts.length > 0) {
      await dispatchDriftNotifications(params.projectId, scannedAlerts);
      inBg(() =>
        enrichDriftAlertsWithAi(params.projectId, activated.id, driftAlerts).catch((err) =>
          logger.error({ err }, 'Background AI drift enrichment failed'),
        ),
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
    inBg(() =>
      dispatchWebhooks(params.projectId, 'plan_activated', {
        planId: activated.id,
        version: activated.version,
        title: activated.title,
        activatedBy: auth.userName,
      }),
    );

    if (driftAlerts.length > 0) {
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

    return NextResponse.json({ data: { ...activated, driftAlerts } });
  } catch (error) {
    return handleApiError(error);
  }
}
