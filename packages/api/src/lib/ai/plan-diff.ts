import { prisma } from '../prisma';
import { aiClient } from './client';
import { PLAN_DIFF_SYSTEM, buildPlanDiffUser } from './prompts/plan-diff.prompt';
import { logger } from '../logger';
import { PLAN_DIFF_TOOL, planDiffResultZ } from './schemas';

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

  let candidate: unknown;
  try {
    candidate = JSON.parse(response);
  } catch (err) {
    logger.error({ err }, 'Failed to parse plan diff AI response');
    return null;
  }

  const safe = planDiffResultZ.safeParse(candidate);
  if (!safe.success) {
    logger.warn(
      { issues: safe.error.flatten() },
      'Plan diff AI response failed schema validation — discarding (no cache write)',
    );
    return null;
  }
  const result: PlanDiffResult = safe.data;

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
