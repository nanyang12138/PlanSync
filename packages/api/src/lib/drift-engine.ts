import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from './logger';
import { prisma } from './prisma';
import { aiClient } from './ai/client';
import { getOrCreatePlanDiff } from './ai/plan-diff';
import { analyzeTaskImpact } from './ai/impact-analysis';
import { escalateLowConfidence } from './ai-escalation';
import { eventBus } from './event-bus';
import { sendMail, userEmail } from './email';
import {
  describeLinkedDeliverableChanges,
  diffDeliverables,
  severityForTaskByDeliverables,
  type DeliverableDiff,
  type DeliverableLite,
  type Severity,
} from '@plansync/shared';

export interface DriftScanResult {
  alerts: Array<{
    taskId: string;
    severity: 'high' | 'medium' | 'low';
    /**
     * Set on alerts derived from a known plan→plan structural diff. Carried
     * through to `persistDriftAlerts` so the pause rule can key off "did the
     * agent's contract actually change" rather than the older
     * "did-the-task-have-a-running-run" heuristic.
     */
    structuralSeverity?: Severity;
    reason: string;
    currentPlanVersion: number;
    taskBoundVersion: number;
    /**
     * Set by `runDriftScan`. Test fixtures that hand-craft alert arrays for
     * `persistDriftAlerts` or `dispatchDriftNotifications` may omit this;
     * treated as `false` in the pause rule so a missing flag never silently
     * pauses something the caller did not intend to interrupt.
     */
    hasRunningExecution?: boolean;
  }>;
}

/**
 * Map the structural classifier's vocabulary (breaking|medium|low) onto the
 * persisted `DriftAlert.severity` column's vocabulary (high|medium|low). We
 * keep the persisted enum unchanged so existing webhooks, UI badge colors and
 * MCP tool outputs that pattern-match on 'high'/'medium'/'low' don't see a
 * schema-shift on the same release that swaps the underlying logic.
 */
function severityToDb(sev: Severity): 'high' | 'medium' | 'low' {
  if (sev === 'breaking') return 'high';
  return sev;
}

/**
 * Scan the project for tasks bound to a now-superseded plan version and emit
 * one alert per task. Severity is derived from the **deliverable-id-based**
 * diff between the task's bound plan and the newly activated plan (R-154):
 * which PlanDeliverable rows were removed, modified (body/refUri/title),
 * added, or unchanged — keyed by the stable row id, not by text hashing.
 *
 * Before R-154 the engine used a text-hash diff over the legacy `Plan.*`
 * String[] columns and treated every plan change (goal, scope, constraints,
 * standards) as a severity driver. That bred alert fatigue: a typo fix in
 * the goal field paused every running task in the project. R-154 narrows
 * the contract:
 *
 *   - 'high'   — a deliverable the task is linked to (via the R-153
 *     `task_deliverable_links` table) was REMOVED, or its `body` was
 *     changed. The task's contract is broken; a running run must be
 *     paused.
 *   - 'medium' — a linked deliverable's `refUri` changed but `body` is
 *     intact. The task should re-orient (e.g. the file glob moved) but
 *     the deliverable text the agent has been reading is unchanged.
 *   - 'low'    — a linked deliverable's `title` is the only field that
 *     changed, OR no linked deliverable appears in the diff, OR the task
 *     has no link rows at all (R-154 step 3 — explicit opt-out from
 *     drift fatigue for tasks that have not declared what they depend on).
 *
 * The "is there a running run" signal is preserved on the alert as the
 * separate field `hasRunningExecution` for the pause rule downstream — it
 * does not drive severity.
 *
 * Fallback: if the activated plan row or any bound-plan row is missing
 * (very unusual — would mean the row was hard-deleted while the activate
 * transaction was in flight), we cannot compute a deliverable diff for
 * that task. We emit an alert with severity='high' and a clearly-labelled
 * fallback reason so the operator notices and the safer side of the choice
 * (block the task) takes effect.
 */
export async function runDriftScan(
  tx: Prisma.TransactionClient | PrismaClient,
  projectId: string,
  newPlanVersion: number,
): Promise<DriftScanResult> {
  const tasks = await tx.task.findMany({
    where: {
      projectId,
      status: { notIn: ['cancelled'] },
      boundPlanVersion: { not: newPlanVersion },
    },
    include: {
      executionRuns: {
        where: { status: 'running' },
      },
      // R-153: pull link rows alongside the task so the R-154 severity
      // classifier can look up "did the deliverable I link to appear in
      // the diff?" without a second round-trip.
      deliverableLinks: {
        include: { deliverable: { select: { id: true, slug: true } } },
      },
    },
  });

  if (tasks.length === 0) {
    return { alerts: [] };
  }

  const newPlan = await tx.plan.findFirst({
    where: { projectId, version: newPlanVersion },
  });

  // Group tasks by their bound version so we compute one deliverable diff
  // per (old, new) pair, regardless of how many tasks share an old version.
  const oldVersions = Array.from(new Set(tasks.map((t) => t.boundPlanVersion)));
  const oldPlans = await tx.plan.findMany({
    where: { projectId, version: { in: oldVersions } },
  });
  const oldPlanByVersion = new Map(oldPlans.map((p) => [p.version, p]));

  // R-154: fetch PlanDeliverable rows for every plan version involved
  // (old versions + the newly activated one) in a single query, then group
  // by planId so `diffDeliverables` can be called once per (old, new) pair.
  const allPlanIds = [...oldPlans.map((p) => p.id), ...(newPlan ? [newPlan.id] : [])];
  const allDeliverables =
    allPlanIds.length > 0
      ? await tx.planDeliverable.findMany({
          where: { planId: { in: allPlanIds } },
          select: {
            id: true,
            planId: true,
            slug: true,
            title: true,
            body: true,
            refUri: true,
          },
        })
      : [];

  const deliverablesByPlanId = new Map<string, DeliverableLite[]>();
  for (const d of allDeliverables) {
    const list = deliverablesByPlanId.get(d.planId) ?? [];
    list.push({
      id: d.id,
      slug: d.slug,
      title: d.title,
      body: d.body,
      refUri: d.refUri,
    });
    deliverablesByPlanId.set(d.planId, list);
  }
  // Maintain a flat id → slug lookup for the human-readable reason builder
  // below; saves another map per alert.
  const slugById = new Map<string, string>();
  for (const d of allDeliverables) slugById.set(d.id, d.slug);

  const newPlanDeliverables = newPlan ? (deliverablesByPlanId.get(newPlan.id) ?? []) : [];

  const diffByOldVersion = new Map<number, DeliverableDiff | null>();
  if (newPlan) {
    for (const ov of oldVersions) {
      const oldPlan = oldPlanByVersion.get(ov);
      const oldDeliverables = oldPlan ? (deliverablesByPlanId.get(oldPlan.id) ?? []) : [];
      diffByOldVersion.set(
        ov,
        oldPlan ? diffDeliverables(oldDeliverables, newPlanDeliverables) : null,
      );
    }
  }

  const alerts: DriftScanResult['alerts'] = [];

  for (const task of tasks) {
    const hasRunningExecution = task.executionRuns.length > 0;
    const diff = newPlan ? diffByOldVersion.get(task.boundPlanVersion) : null;

    let structuralSeverity: Severity;
    let reason: string;
    if (diff) {
      const linkedIds = task.deliverableLinks.map((l) => l.deliverable.id);
      structuralSeverity = severityForTaskByDeliverables(linkedIds, diff);
      const runSuffix = hasRunningExecution ? ' (run currently in flight)' : '';
      const changedSummary = describeLinkedDeliverableChanges(linkedIds, diff, slugById);
      const baseLine = `Task "${task.title}" bound to v${task.boundPlanVersion}, now v${newPlanVersion}.`;
      if (changedSummary) {
        reason = `${baseLine} Linked deliverable changes: ${changedSummary} — ${structuralSeverity} for this task${runSuffix}.`;
      } else if (linkedIds.length === 0) {
        // R-154 step 3 — no link rows ⇒ no basis to alert. We still emit
        // the row at severity='low' so the activity log shows the version
        // bump happened, but the gate/pause rules in `persistDriftAlerts`
        // skip low-severity entries.
        reason = `${baseLine} Task has no deliverable links; treating as ${structuralSeverity} (no alert-worthy impact).`;
      } else {
        reason = `${baseLine} Linked deliverables unchanged by this version — ${structuralSeverity} for this task${runSuffix}.`;
      }
    } else {
      // Fall back to a conservative 'high' if we cannot compute a
      // deliverable diff (e.g. the bound plan row was hard-deleted).
      // Operator sees the alert; pause-runs fires; nothing slips through
      // silently.
      structuralSeverity = 'breaking';
      reason = `Task "${task.title}" bound to v${task.boundPlanVersion} (plan row missing); cannot compute structural diff. Treating as breaking change.`;
    }

    alerts.push({
      taskId: task.id,
      severity: severityToDb(structuralSeverity),
      structuralSeverity,
      reason,
      currentPlanVersion: newPlanVersion,
      taskBoundVersion: task.boundPlanVersion,
      hasRunningExecution,
    });
  }

  logger.info(
    {
      projectId,
      newPlanVersion,
      alertCount: alerts.length,
      bySeverity: alerts.reduce<Record<string, number>>((acc, a) => {
        acc[a.severity] = (acc[a.severity] ?? 0) + 1;
        return acc;
      }, {}),
    },
    'Drift scan completed',
  );
  return { alerts };
}

export async function persistDriftAlerts(
  tx: Prisma.TransactionClient | PrismaClient,
  projectId: string,
  alerts: DriftScanResult['alerts'],
) {
  if (alerts.length === 0) return [];

  // R-051: at most one open DriftAlert per task. Before writing the freshly
  // computed alerts, supersede every existing open alert on the affected
  // tasks so the new ones become the single open row each. Without this
  // step, the partial unique index `drift_alerts_one_open_per_task` (see
  // migration 20260523100000) would reject the createMany when the task
  // already has an open row from a prior activation.
  //
  // Marked as `resolvedAction='superseded'`, `resolvedBy='system'` so the
  // history is preserved and clearly attributed to the engine rather than
  // a human operator. Both writes live inside the caller's transaction so
  // a rollback restores the prior open alerts untouched.
  const supersedeTaskIds = Array.from(new Set(alerts.map((a) => a.taskId)));
  await tx.driftAlert.updateMany({
    where: { taskId: { in: supersedeTaskIds }, status: 'open' },
    data: {
      status: 'resolved',
      resolvedAction: 'superseded',
      resolvedBy: 'system',
      resolvedAt: new Date(),
    },
  });

  const created = await tx.driftAlert.createManyAndReturn({
    data: alerts.map((a) => ({
      projectId,
      taskId: a.taskId,
      type: 'version_mismatch',
      severity: a.severity,
      reason: a.reason,
      status: 'open',
      currentPlanVersion: a.currentPlanVersion,
      taskBoundVersion: a.taskBoundVersion,
    })),
  });

  // R-002 + R-140 drift v2 — two coordinated atomic writes, both inside the
  // caller's transaction so a roll-back cleanly reverts everything:
  //
  //   1. Gate the task. Any task with severity at least 'medium' (i.e. the
  //      plan change touched something the task references, or referenced
  //      scope/standards) has its `executionGate` column set so no new
  //      execution_start can race in while the drift sits unresolved. Tasks
  //      with severity='low' are intentionally NOT gated — by definition
  //      the change does not affect them, so gating would be alert fatigue.
  //
  //      Before R-140 the engine wrote `status='blocked'` here. That
  //      conflated "system gated this because the plan drifted" with the
  //      owner-meaningful blocked state used by heartbeat-scanner /
  //      failed-run paths. The new column keeps the two distinct so the
  //      banner/CLI can say "blocked by drift v2" while the underlying
  //      task lifecycle (todo / in_progress) is untouched.
  //
  //   2. Pause running runs of those tasks. The set is `severity != 'low'
  //      AND hasRunningExecution`. The runs/[runId] route rejects any
  //      heartbeat or complete on a paused run with 409 RUN_PAUSED; the MCP
  //      client maps that to an AbortController fire so the agent's ai-loop
  //      breaks out at the next tool call (defense in depth: SSE is
  //      best-effort, but the DB-side gate is authoritative).
  //
  // The pause set is a subset of the gated set: a run-less task can still
  // get gated because something it references changed, but there's nothing
  // running to pause. The `status='running'` filter on the updateMany leaves
  // alone any run that the agent voluntarily completed in the millisecond
  // between drift scan and persist.
  const blockingAlerts = alerts.filter((a) => a.severity !== 'low');
  if (blockingAlerts.length > 0) {
    // Per-task gate value tracks the alert's severity so the banner can
    // pick a copy that matches: 'drift_high' (breaking — agent contract
    // changed) vs 'drift_medium' (re-orient — referenced scope/standard
    // changed but deliverables intact).
    const highTaskIds = blockingAlerts.filter((a) => a.severity === 'high').map((a) => a.taskId);
    const mediumTaskIds = blockingAlerts
      .filter((a) => a.severity === 'medium')
      .map((a) => a.taskId);
    if (highTaskIds.length > 0) {
      await tx.task.updateMany({
        where: { id: { in: highTaskIds } },
        data: { executionGate: 'drift_high' },
      });
    }
    if (mediumTaskIds.length > 0) {
      await tx.task.updateMany({
        where: { id: { in: mediumTaskIds } },
        // A task that already has 'drift_high' from a prior alert in the
        // same persist call would otherwise be downgraded; since the same
        // task only appears in one severity bucket per call (alerts is
        // pre-grouped by taskId in runDriftScan) this updateMany is safe.
        data: { executionGate: 'drift_medium' },
      });
    }

    const pauseTaskIds = blockingAlerts.filter((a) => a.hasRunningExecution).map((a) => a.taskId);
    if (pauseTaskIds.length > 0) {
      await tx.executionRun.updateMany({
        where: { taskId: { in: pauseTaskIds }, status: 'running' },
        data: { status: 'paused' },
      });
    }
  }

  return created;
}

/**
 * Dispatch per-assignee SSE events and notification emails for a freshly
 * persisted batch of drift alerts.
 *
 * **Always call this AFTER the enclosing `$transaction` has resolved** so a
 * rolled-back transaction does not produce "ghost" notifications (R-007).
 *
 * Note: the project-channel `drift_detected` SSE event is published by the
 * calling route (activate / reactivate), so this function only handles the
 * per-assignee personal-channel SSE and email side-effects.
 */
export async function dispatchDriftNotifications(
  projectId: string,
  alerts: DriftScanResult['alerts'],
): Promise<void> {
  if (alerts.length === 0) return;

  const taskIds = alerts.map((a) => a.taskId);
  const tasks = await prisma.task.findMany({
    where: { id: { in: taskIds }, assignee: { not: null } },
    select: { id: true, title: true, assignee: true },
  });

  const byAssignee = new Map<string, Array<{ title: string; reason: string; severity: string }>>();
  for (const alert of alerts) {
    const task = tasks.find((t) => t.id === alert.taskId);
    if (!task?.assignee) continue;
    if (!byAssignee.has(task.assignee)) byAssignee.set(task.assignee, []);
    byAssignee
      .get(task.assignee)!
      .push({ title: task.title, reason: alert.reason, severity: alert.severity });
  }

  if (byAssignee.size === 0) return;

  const assigneeNames = Array.from(byAssignee.keys());
  const humanMembers = await prisma.projectMember.findMany({
    where: { projectId, name: { in: assigneeNames }, type: 'human' },
    select: { name: true },
  });
  const humanSet = new Set(humanMembers.map((m) => m.name));

  for (const [assignee, affected] of byAssignee.entries()) {
    if (!humanSet.has(assignee)) continue;
    const lines = affected.map((a) => `  • "${a.title}": ${a.reason}`).join('\n');
    const body = [
      `The following tasks have drift alerts that require your attention:`,
      '',
      lines,
      '',
      `Please log in to PlanSync to review and resolve these drift alerts.`,
    ].join('\n');
    const ok = sendMail(
      [userEmail(assignee)],
      `[PlanSync] Drift alert: your tasks need attention`,
      body,
    );
    if (!ok) logger.warn({ assignee, projectId }, 'Failed to send drift notification email');

    // Push to the assignee's personal channel so they see the flash even if
    // they are not currently subscribed to this project's SSE stream.
    eventBus.publishToUser(assignee, 'drift_detected', projectId, {
      alerts: affected,
    });
  }
}

/**
 * Runs after drift alerts are persisted; uses AI when available to enrich
 * DriftAlert rows.
 *
 * Layout: batch DB reads, dedup plan-diffs (one AI call per unique plan pair),
 * then run per-task impact analyses in parallel. The original implementation
 * processed alerts in a serial for-loop, which made N drifts take N × AI
 * latency (5–15 s each). With N=5 the wait was ~1 minute; this version
 * collapses it to roughly one AI round-trip.
 */
export async function enrichDriftAlertsWithAi(
  projectId: string,
  activePlanId: string,
  alerts: Array<{ id: string; taskId: string }>,
): Promise<void> {
  if (!aiClient.isAvailable || alerts.length === 0) return;

  // 1. Batch-fetch tasks and the bound-plan rows they reference.
  const tasks = await prisma.task.findMany({
    where: { id: { in: alerts.map((a) => a.taskId) } },
  });
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const boundVersions = Array.from(new Set(tasks.map((t) => t.boundPlanVersion)));
  const boundPlans = boundVersions.length
    ? await prisma.plan.findMany({
        where: { projectId, version: { in: boundVersions } },
      })
    : [];
  const boundPlanByVersion = new Map(boundPlans.map((p) => [p.version, p]));

  // 2. Compute plan-diffs in parallel — one per unique (fromPlanId, toPlanId).
  // getOrCreatePlanDiff is DB-cached and tolerates the P2002 race that two
  // concurrent first-time computations of the same pair would produce.
  const uniqueDiffPairs = new Map<string, string>(); // fromPlanId → fromPlanId
  for (const plan of boundPlans) {
    if (plan.id !== activePlanId) uniqueDiffPairs.set(plan.id, plan.id);
  }
  const diffEntries = await Promise.all(
    Array.from(uniqueDiffPairs.keys()).map(async (fromPlanId) => {
      const diff = await getOrCreatePlanDiff(projectId, fromPlanId, activePlanId);
      return [fromPlanId, diff] as const;
    }),
  );
  const diffByBoundPlanId = new Map(diffEntries);

  // R-191a: track the per-alert outcomes so we can escalate when the
  // whole enrich pass systemically fails (e.g. provider outage). One
  // owner notification covers the entire pass rather than spamming on
  // every alert.
  let enrichAttempts = 0;
  let enrichFailures = 0;

  // 3. Run impact analysis + DriftAlert update for each alert in parallel.
  // Each iteration is independent: distinct DriftAlert row, distinct AI call.
  await Promise.all(
    alerts.map(async (alert) => {
      try {
        const task = taskById.get(alert.taskId);
        if (!task) return;

        const boundPlan = boundPlanByVersion.get(task.boundPlanVersion);
        if (!boundPlan || boundPlan.id === activePlanId) return;

        const diff = diffByBoundPlanId.get(boundPlan.id);
        if (!diff) return;

        enrichAttempts += 1;
        // R-191a: pass projectId / taskId so impact-analysis can
        // escalate single-task low-confidence signals straight to owner.
        const impact = await analyzeTaskImpact(diff, task, projectId, task.id);
        if (!impact) {
          enrichFailures += 1;
          return;
        }

        const planDiffRow = await prisma.planDiff.findUnique({
          where: { fromPlanId_toPlanId: { fromPlanId: boundPlan.id, toPlanId: activePlanId } },
        });

        // R-001: AI is advisory only — never auto-resolve drift or unblock the
        // task. We persist the score, reasoning, suggested action and affected
        // areas so the UI/CLI can surface them as suggestions, but the human
        // (or owner) must explicitly call drift_resolve to change the alert
        // status. This prevents the agent from silently overriding plan-change
        // decisions when the heuristic compatibility score happens to be high.
        await prisma.driftAlert.update({
          where: { id: alert.id },
          data: {
            compatibilityScore: impact.compatibilityScore,
            impactAnalysis: impact.reasoning,
            suggestedAction: impact.suggestedAction,
            affectedAreas: impact.affectedAreas,
            planDiffId: planDiffRow?.id ?? null,
          },
        });
      } catch (err) {
        enrichFailures += 1;
        logger.error({ err, alertId: alert.id }, 'Failed to enrich drift alert with AI');
      }
    }),
  );

  // R-191a: if every (or near-every) enrich attempt failed, the LLM
  // provider chain is likely broken. Escalate ONCE for the whole pass
  // rather than per-alert spam. Threshold: at least 3 attempts and >=
  // 80% failure rate. The escalation module's own rate-limit (1/hour
  // per project+kind) further smooths out reconnect churn.
  if (enrichAttempts >= 3 && enrichFailures / enrichAttempts >= 0.8) {
    void escalateLowConfidence(projectId, 'drift_enrich_systematic_failure', {
      summary: `AI drift-enrich pass failed on ${enrichFailures} of ${enrichAttempts} alerts after activating plan ${activePlanId}. Drift alerts will remain without AI suggestions until the provider recovers.`,
      details: { enrichAttempts, enrichFailures, activePlanId },
    });
  }
}
