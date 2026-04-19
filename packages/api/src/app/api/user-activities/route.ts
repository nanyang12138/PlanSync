import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const RETENTION_DAYS = 7;

export async function GET(req: NextRequest) {
  try {
    const auth = await authenticate(req);

    const limitParam = Number(req.nextUrl.searchParams.get('limit'));
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const memberships = await prisma.projectMember.findMany({
      where: { name: auth.userName, type: 'human' },
      include: { project: { select: { id: true, name: true } } },
    });

    if (memberships.length === 0) {
      return NextResponse.json({
        data: [],
        unreadCount: 0,
        lastSeenActivityAt: null,
      });
    }

    const projectIds = memberships.map((m) => m.project.id);
    const projectMap = Object.fromEntries(memberships.map((m) => [m.project.id, m.project.name]));

    const since = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const [activities, userState] = await Promise.all([
      prisma.activity.findMany({
        where: {
          projectId: { in: projectIds },
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.userState.findUnique({ where: { userName: auth.userName } }),
    ]);

    const lastSeen = userState?.lastSeenActivityAt ?? null;

    const unreadCount = lastSeen
      ? await prisma.activity.count({
          where: {
            projectId: { in: projectIds },
            createdAt: { gt: lastSeen },
          },
        })
      : await prisma.activity.count({
          where: { projectId: { in: projectIds } },
        });

    return NextResponse.json({
      data: activities.map((a) => ({
        id: a.id,
        projectId: a.projectId,
        projectName: projectMap[a.projectId] ?? a.projectId,
        type: a.type,
        actorName: a.actorName,
        actorType: a.actorType,
        summary: a.summary,
        metadata: a.metadata,
        createdAt: a.createdAt,
        unread: lastSeen ? a.createdAt > lastSeen : true,
      })),
      unreadCount,
      lastSeenActivityAt: lastSeen,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
