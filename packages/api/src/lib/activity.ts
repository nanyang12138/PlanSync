import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { activityTypeSchema, actorTypeSchema, AppError, ErrorCode } from '@plansync/shared';
import { prisma } from './prisma';

export type ActivityType = z.infer<typeof activityTypeSchema>;
export type ActorType = z.infer<typeof actorTypeSchema>;

export async function createActivity(params: {
  projectId: string;
  type: ActivityType;
  actorName: string;
  actorType: ActorType;
  summary: string;
  metadata?: Prisma.InputJsonValue;
}) {
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
  return prisma.activity.create({ data: params });
}
