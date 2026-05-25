import { PrismaClient, type Prisma } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// R-190 / closes #780 #796: every Project field that is safe to expose to
// any project member or any caller of the public project APIs. The
// `githubWebhookSecret` column is the HMAC shared secret used by the
// GitHub webhook receiver — it MUST NOT leak through `findMany` /
// `findUnique` on the project list / detail / dashboard / member /
// notify routes (which previously returned the entire row including
// the secret to any project member, escalating "I'm in this project"
// to "I can forge any GitHub webhook delivery to this project").
//
// Routes that legitimately need the secret (today: the webhook
// receiver) read it explicitly with their own narrow `select`. The
// rule is: if you can avoid touching `prisma.project.*` with a wide
// shape, use {@link PROJECT_PUBLIC_SELECT}. If you absolutely need
// extra fields, list them explicitly — never spread `...PROJECT_*`
// blindly into a payload the client receives.
export const PROJECT_PUBLIC_SELECT = {
  id: true,
  name: true,
  description: true,
  phase: true,
  repoUrl: true,
  defaultBranch: true,
  githubRepo: true,
  // githubWebhookSecret intentionally OMITTED.
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ProjectSelect;
