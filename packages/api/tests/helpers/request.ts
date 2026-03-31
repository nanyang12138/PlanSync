import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export function makeReq(
  url: string,
  opts?: {
    method?: string;
    userName?: string;
    body?: unknown;
    searchParams?: Record<string, string>;
    authToken?: string;
  },
): NextRequest {
  const full = new URL(url, 'http://localhost');
  if (opts?.searchParams) {
    Object.entries(opts.searchParams).forEach(([k, v]) => full.searchParams.set(k, v));
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts?.userName) headers['x-user-name'] = opts.userName;
  if (opts?.authToken) headers['authorization'] = `Bearer ${opts.authToken}`;
  return new NextRequest(full.toString(), {
    method: opts?.method ?? 'GET',
    headers,
    body: opts?.body != null ? JSON.stringify(opts.body) : undefined,
  });
}

export async function createTestProject(owner: string) {
  const p = await prisma.$transaction(async (tx) => {
    const proj = await tx.project.create({
      data: {
        name: `t-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        phase: 'planning',
        createdBy: owner,
      },
    });
    await tx.projectMember.create({
      data: { projectId: proj.id, name: owner, role: 'owner', type: 'human' },
    });
    return proj;
  });
  return { projectId: p.id };
}

export async function addMember(
  projectId: string,
  name: string,
  role: 'owner' | 'developer' = 'developer',
) {
  await prisma.projectMember.create({
    data: { projectId, name, role, type: 'human' },
  });
}

export async function createActivePlan(projectId: string, createdBy: string) {
  const latest = await prisma.plan.findFirst({
    where: { projectId },
    orderBy: { version: 'desc' },
  });
  const p = await prisma.plan.create({
    data: {
      projectId,
      title: 'Test Plan',
      goal: 'Test goal',
      scope: 'Test scope',
      version: (latest?.version ?? 0) + 1,
      status: 'active',
      createdBy,
      activatedAt: new Date(),
      activatedBy: createdBy,
    },
  });
  return { planId: p.id, version: p.version };
}

export async function cleanupProject(projectId: string) {
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
}

export { prisma as testPrisma };
