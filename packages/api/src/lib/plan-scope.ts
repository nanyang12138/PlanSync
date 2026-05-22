import type { Plan, Prisma, PrismaClient } from '@prisma/client';
import { AppError, ErrorCode } from '@plansync/shared';
import { prisma as defaultPrisma } from './prisma';

type PrismaLike = PrismaClient | Prisma.TransactionClient;

/**
 * R-041: Verify that a plan belongs to the expected project before exposing
 * any sub-resource (comments, suggestions, reviews, append, diff, propose,
 * activate, reactivate, …).
 *
 * Without this check, a member of project A could read/write plan sub-resources
 * of project B simply by knowing/guessing the `planId`, because nested routes
 * only authorize on `params.projectId` while looking up the plan by `planId`.
 *
 * Both "plan does not exist" and "plan belongs to a different project" are
 * intentionally collapsed into the same `NOT_FOUND` response so callers cannot
 * probe for plan existence across projects.
 *
 * By default returns the full Plan record. Callers that need related rows can
 * pass `include` (typed via the optional `T` generic) and will receive
 * `Plan & T`.
 */
export async function requirePlanInProject<T = unknown>(
  planId: string,
  projectId: string,
  options?: {
    db?: PrismaLike;
    include?: Prisma.PlanInclude;
  },
): Promise<Plan & T> {
  const db = options?.db ?? defaultPrisma;
  const args: Prisma.PlanFindUniqueArgs = { where: { id: planId } };
  if (options?.include) args.include = options.include;
  const plan = (await db.plan.findUnique(args)) as (Plan & T) | null;
  if (!plan || plan.projectId !== projectId) {
    throw new AppError(ErrorCode.NOT_FOUND, 'Plan not found');
  }
  return plan;
}
