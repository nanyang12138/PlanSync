/**
 * R-136: `GET /api/auth/master-audit?since=<iso>`
 *
 * Owner-only window into the `master_delegations` audit table. "Owner" in
 * this context is workspace-scoped — any user who holds an `owner` role on
 * at least one project can read the audit trail, since a master-delegation
 * episode is intrinsically workspace-wide (the secret unlocks every user,
 * not just one project's users).
 *
 * Returns rows ordered by `occurredAt DESC`, capped at 500 rows per call.
 * Larger windows must be paginated by passing a more recent `since=` on
 * the next call.
 *
 * Wire shape:
 *
 *   {
 *     "data": [
 *       { id, callerIp, callerUa, targetUser,
 *         routeMethod, routePath, occurredAt, expiresAt }
 *     ],
 *     "meta": { count, capped, since }
 *   }
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { AppError, ErrorCode } from '@plansync/shared';

const MAX_ROWS = 500;

const sinceSchema = z.coerce.date().optional();

export async function GET(req: NextRequest) {
  try {
    const auth = await authenticate(req);

    // Workspace-owner gate: must own at least one project.
    const ownedCount = await prisma.projectMember.count({
      where: { name: auth.userName, role: 'owner' },
    });
    if (ownedCount === 0) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'master-audit requires owner role on at least one project',
      );
    }

    const sinceParam = req.nextUrl.searchParams.get('since');
    const sinceParsed = sinceSchema.safeParse(sinceParam ?? undefined);
    if (!sinceParsed.success) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid 'since' parameter; expected ISO-8601 timestamp`,
      );
    }
    const since = sinceParsed.data;

    const rows = await prisma.masterDelegation.findMany({
      where: since ? { occurredAt: { gte: since } } : {},
      orderBy: { occurredAt: 'desc' },
      take: MAX_ROWS,
    });

    return NextResponse.json({
      data: rows,
      meta: {
        count: rows.length,
        capped: rows.length === MAX_ROWS,
        since: since?.toISOString() ?? null,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
