import { prisma } from '../prisma';
import { aiClient } from './client';
import { PLAN_DIFF_SYSTEM, buildPlanDiffUser } from './prompts/plan-diff.prompt';
import { logger } from '../logger';

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

  const response = await aiClient.complete(PLAN_DIFF_SYSTEM, buildPlanDiffUser(planA, planB));
  if (!response) return null;

  try {
    const result = JSON.parse(response) as PlanDiffResult;
    try {
      await prisma.planDiff.create({
        data: { projectId, fromPlanId, toPlanId, changes: result as object },
      });
    } catch (dbErr: any) {
      if (dbErr?.code === 'P2002') {
        logger.debug('PlanDiff already cached by concurrent request');
      } else {
        logger.warn({ err: dbErr }, 'Failed to cache plan diff');
      }
    }
    return result;
  } catch (err) {
    logger.error({ err }, 'Failed to parse plan diff AI response');
    return null;
  }
}
