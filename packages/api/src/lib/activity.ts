import { prisma } from './prisma';

export async function createActivity(params: {
  projectId: string;
  type: string;
  actorName: string;
  actorType: 'human' | 'agent' | 'system';
  summary: string;
  metadata?: Record<string, unknown>;
}) {
  return prisma.activity.create({ data: params });
}
