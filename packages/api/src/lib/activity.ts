import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

export async function createActivity(params: {
  projectId: string;
  type: string;
  actorName: string;
  actorType: 'human' | 'agent' | 'system';
  summary: string;
  metadata?: Prisma.InputJsonValue;
}) {
  return prisma.activity.create({ data: params });
}
