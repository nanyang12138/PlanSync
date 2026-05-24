import { planDiffChangesSchema } from '@plansync/shared';
import { prisma } from '../prisma';
import { aiClient } from './client';
import {
  PLAN_DIFF_PROMPT_VERSION,
  PLAN_DIFF_SYSTEM,
  buildPlanDiffUser,
} from './prompts/plan-diff.prompt';
import { logger } from '../logger';
import { PLAN_DIFF_TOOL, planDiffResultZ } from './schemas';
import { assertLiteralsInContext, logValidationWarnings, validateOrNull } from './validate';
import { verifyPlanDiffBreaking } from './verifier';

export interface PlanDiffResult {
  changes: Array<{
    aspect: string;
    type: string;
    from: string | null;
    to: string | null;
    impact: string;
    description: string;
    affectedAreas: string[];
  }>;
  summary: string;
  breakingChanges: boolean;
}

export async function getOrCreatePlanDiff(
  projectId: string,
  fromPlanId: string,
  toPlanId: string,
): Promise<PlanDiffResult | null> {
  const existing = await prisma.planDiff.findUnique({
    where: { fromPlanId_toPlanId: { fromPlanId, toPlanId } },
  });
  if (existing) {
    if (existing.projectId !== projectId) return null;
    // R-145: validate the cached row against the shared schema BEFORE
    // returning. A row that fails safeParse here was either written
    // before the schema was tightened, came from a now-removed AI
    // provider, or was hand-edited by an admin debugging the DB. In all
    // three cases we'd rather discard + re-derive than ship corrupt
    // input downstream (drift engine, plans page, impact analysis all
    // narrow into different keys and silently misbehave on bad data).
    const cacheParse = planDiffChangesSchema.safeParse(existing.changes);
    if (cacheParse.success) {
      return cacheParse.data as unknown as PlanDiffResult;
    }
    logger.warn(
      {
        projectId,
        fromPlanId,
        toPlanId,
        issues: cacheParse.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
      'plan_diff cache row failed shared schema validation — discarding and recomputing',
    );
    try {
      await prisma.planDiff.delete({
        where: { fromPlanId_toPlanId: { fromPlanId, toPlanId } },
      });
    } catch (delErr: unknown) {
      logger.debug({ err: delErr }, 'Failed to evict stale plan_diff cache row (continuing)');
    }
  }

  if (!aiClient.isAvailable) return null;

  const [planA, planB] = await Promise.all([
    prisma.plan.findUnique({ where: { id: fromPlanId } }),
    prisma.plan.findUnique({ where: { id: toPlanId } }),
  ]);
  if (!planA || !planB) return null;
  if (planA.projectId !== projectId || planB.projectId !== projectId) return null;

  // R-185: previously this path did `JSON.parse(response) as PlanDiffResult`
  // with NO field validation and then wrote straight to planDiff (which is
  // persistent + cached). A single bad output got pinned to the (fromPlanId,
  // toPlanId) pair indefinitely. Strict tool_use forces the model into the
  // exact shape, and zod.safeParse below catches anything that slips past
  // (mock provider / text fallback / future schema drift) BEFORE we touch
  // the DB cache.
  const response = await aiClient.complete(PLAN_DIFF_SYSTEM, buildPlanDiffUser(planA, planB), {
    purpose: 'plan_diff',
    promptVersion: PLAN_DIFF_PROMPT_VERSION,
    tool: PLAN_DIFF_TOOL,
  });
  if (!response) return null;

  // R-186: validateOrNull replaces the bare JSON.parse + safeParse pair.
  // We additionally run literal grounding on the candidate's `from`/`to`
  // strings — those are model-emitted quotes that must match the original
  // plan text; ungrounded literals are a strong signal the model
  // paraphrased rather than copied (which corrupts downstream drift
  // analysis).
  const validated = validateOrNull(response, planDiffResultZ);
  if (!validated.ok) {
    logger.warn(
      { issues: validated.issues },
      'Plan diff AI response failed schema validation — discarding (no cache write)',
    );
    return null;
  }
  const result: PlanDiffResult = validated.value;

  // Literal grounding: flag each change whose from/to contains literals
  // (dates / money / quoted strings) that don't appear in the source
  // plans. Soft signal — we log + tag, we don't block the cache write,
  // because false positives are easy (model paraphrased a quoted heading
  // by changing a delimiter). R-187 will follow up with a hard verifier
  // pass on the breaking-change subset.
  const fullContext = [
    planA.goal ?? '',
    planA.scope ?? '',
    JSON.stringify(planA.constraints ?? []),
    JSON.stringify(planA.standards ?? []),
    JSON.stringify(planA.deliverables ?? []),
    JSON.stringify(planA.openQuestions ?? []),
    planB.goal ?? '',
    planB.scope ?? '',
    JSON.stringify(planB.constraints ?? []),
    JSON.stringify(planB.standards ?? []),
    JSON.stringify(planB.deliverables ?? []),
    JSON.stringify(planB.openQuestions ?? []),
  ].join('\n');
  const allWarnings: string[] = [];
  for (let i = 0; i < result.changes.length; i++) {
    const change = result.changes[i];
    const obj: Record<string, unknown> = {
      from: change.from ?? '',
      to: change.to ?? '',
    };
    const grounding = assertLiteralsInContext(obj, fullContext, ['from', 'to']);
    if (grounding.ungrounded.length > 0) {
      allWarnings.push(`change[${i}]: ${grounding.warnings.join('; ')}`);
    }
  }
  logValidationWarnings('plan_diff', allWarnings, {
    projectId,
    fromPlanId,
    toPlanId,
    changeCount: result.changes.length,
  });

  // R-187: only the breakingChanges=true path cascades to drift impact
  // analysis across every open task, so it's the highest-side-effect bit
  // in the response. Run a cheap second LLM pass; on reject/partial,
  // downgrade breakingChanges to false BEFORE the cache write so the
  // false-positive doesn't get pinned to the (fromPlanId, toPlanId) pair.
  // The original value + verifier reasoning is preserved in an opaque
  // `_meta` field so audit + UI can surface "we downgraded this" instead
  // of silently lying.
  let persisted: PlanDiffResult = result;
  if (result.breakingChanges) {
    const verdict = await verifyPlanDiffBreaking({
      planA,
      planB,
      candidate: result,
    });
    if (verdict && verdict.verdict !== 'agree') {
      logger.warn(
        {
          projectId,
          fromPlanId,
          toPlanId,
          verifierVerdict: verdict.verdict,
          verifierReasoning: verdict.reasoning,
        },
        'plan_diff_breaking_change_downgraded_by_verifier',
      );
      persisted = {
        ...result,
        breakingChanges: false,
      };
      (persisted as PlanDiffResult & { _meta?: unknown })._meta = {
        verifierDisagreed: true,
        originalBreakingChanges: true,
        verifierVerdict: verdict.verdict,
        verifierReasoning: verdict.reasoning,
      };
    }
  }

  // R-145: enforce the shared schema BEFORE writing the JSON column.
  // `parse` (not safeParse) is intentional — at this point the row is
  // about to be cached for every reader, so we'd rather fail loud + the
  // caller gets `null` from `validateOrNull` semantics one level up than
  // silently pin a malformed shape to the (fromPlanId, toPlanId) pair.
  // `persisted` may carry the R-187 `_meta` audit envelope; the schema's
  // top-level passthrough keeps that field intact.
  let toPersist: object;
  try {
    toPersist = planDiffChangesSchema.parse(persisted) as object;
  } catch (schemaErr: unknown) {
    logger.warn(
      {
        projectId,
        fromPlanId,
        toPlanId,
        err: schemaErr,
      },
      'plan_diff payload failed shared schema validation — refusing to cache',
    );
    return null;
  }
  try {
    await prisma.planDiff.create({
      data: { projectId, fromPlanId, toPlanId, changes: toPersist },
    });
  } catch (dbErr: unknown) {
    const code =
      typeof dbErr === 'object' && dbErr !== null && 'code' in dbErr
        ? (dbErr as { code?: unknown }).code
        : undefined;
    if (code === 'P2002') {
      logger.debug('PlanDiff already cached by concurrent request');
    } else {
      logger.warn({ err: dbErr }, 'Failed to cache plan diff');
    }
  }
  return persisted;
}
