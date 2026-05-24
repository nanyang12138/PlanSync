import { prisma } from '../prisma';
import { aiClient } from './client';
import { PLAN_DIFF_SYSTEM, buildPlanDiffUser } from './prompts/plan-diff.prompt';
import { logger } from '../logger';
import { PLAN_DIFF_TOOL, planDiffResultZ } from './schemas';
import {
  assertLiteralsInContext,
  logValidationWarnings,
  validateOrNull,
} from './validate';

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
    return existing.changes as unknown as PlanDiffResult;
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

  try {
    await prisma.planDiff.create({
      data: { projectId, fromPlanId, toPlanId, changes: result as object },
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
  return result;
}
