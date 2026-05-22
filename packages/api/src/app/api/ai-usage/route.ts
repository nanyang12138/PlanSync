// R-182 (supersedes R-144): owner-only AI usage aggregation.
//
// This endpoint surfaces per-purpose call counts, latency percentiles,
// token totals, and cache hit ratio so the owner can do simple ROI
// review on LLM spend without trawling logs. "Owner" here means the
// caller holds the `owner` role on at least one project — there is no
// org-wide concept yet.
//
// Authentication path:
//   1. Reject anonymous + exec-scoped sessions.
//   2. Confirm the caller has at least one project where they are owner.
// We deliberately do NOT scope the aggregate to that project's calls
// only, because ai_calls today has no project_id column (LLM usage is a
// cross-project concern). When per-project attribution lands we can
// switch this to a project filter without changing the wire shape.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { authenticate, requireNotExecScoped } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { aggregateAiUsage } from '@/lib/ai/usage';
import { AppError, ErrorCode } from '@plansync/shared';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  since: z
    .string()
    .datetime({ offset: true })
    .optional(),
  until: z
    .string()
    .datetime({ offset: true })
    .optional(),
});

export async function GET(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    requireNotExecScoped(auth);

    const parsed = querySchema.safeParse({
      since: req.nextUrl.searchParams.get('since') ?? undefined,
      until: req.nextUrl.searchParams.get('until') ?? undefined,
    });
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, parsed.error.message);
    }

    // R-182: gate on "is owner of any project". The owner check is the
    // documented requirement; we look it up directly so the route stays
    // a thin wrapper over aggregateAiUsage() and stays mock-friendly.
    const ownerCount = await prisma.projectMember.count({
      where: { name: auth.userName, role: 'owner' },
    });
    if (ownerCount === 0) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'AI usage stats are restricted to project owners',
      );
    }

    const usage = await aggregateAiUsage({
      since: parsed.data.since ? new Date(parsed.data.since) : undefined,
      until: parsed.data.until ? new Date(parsed.data.until) : undefined,
    });

    return NextResponse.json({
      data: usage.buckets,
      totalCalls: usage.totalCalls,
      rangeFrom: usage.rangeFrom,
      rangeTo: usage.rangeTo,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
