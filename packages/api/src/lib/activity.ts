import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { activityTypeSchema, actorTypeSchema, AppError, ErrorCode } from '@plansync/shared';
import { prisma } from './prisma';

export type ActivityType = z.infer<typeof activityTypeSchema>;
export type ActorType = z.infer<typeof actorTypeSchema>;

export async function createActivity(
  params: {
    projectId: string;
    type: ActivityType;
    actorName: string;
    actorType: ActorType;
    summary: string;
    metadata?: Prisma.InputJsonValue;
  },
  // Closes #753 — owner-write routes (e.g. PATCH /plans/:id) need
  // the activity row to commit atomically with the underlying state
  // change. Pre-fix this helper always wrote via the global prisma
  // client AFTER the route's $transaction had already committed; if
  // the activity insert then failed (DB connection drop, FK race,
  // etc.), the audit log lost a row but the plan was already
  // mutated, breaking the every-owner-write-is-audited invariant.
  // Pass the enclosing $transaction's `tx` to write inside the same
  // atomic envelope. Existing call-sites that don't care about
  // atomicity (mid-tx writes are sometimes intentionally deferred so
  // the activity reflects post-commit state) keep working unchanged
  // because the parameter is optional.
  tx?: Prisma.TransactionClient,
) {
  // R-033: enforce zod validation on type/actorType so typos like
  // 'task_complted' or 'agentt' fail loudly instead of silently writing
  // garbage to the audit log.
  const typeResult = activityTypeSchema.safeParse(params.type);
  if (!typeResult.success) {
    throw new AppError(
      ErrorCode.INTERNAL,
      `Unknown activity type "${String(params.type)}". Add it to activityTypeSchema before use.`,
      { invalidType: params.type },
    );
  }
  const actorResult = actorTypeSchema.safeParse(params.actorType);
  if (!actorResult.success) {
    throw new AppError(
      ErrorCode.INTERNAL,
      `Unknown actor type "${String(params.actorType)}". Must be human, agent, or system.`,
      { invalidActorType: params.actorType },
    );
  }
  const client = tx ?? prisma;
  return client.activity.create({ data: params });
}
