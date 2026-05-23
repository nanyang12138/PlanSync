import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { authenticate, invalidateApiKeyCacheByExecRunId } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { validateBody } from '@/lib/validate';
import { AppError, ErrorCode } from '@plansync/shared';

const revokeSchema = z.object({
  runId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    const body = await validateBody(req, revokeSchema);

    if (auth.execRunId) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Exec-scoped sessions cannot revoke their own tokens',
      );
    }

    const result = await prisma.apiKey.deleteMany({
      where: { execRunId: body.runId, createdBy: auth.userName },
    });

    // R-141: drop any cached principal for this run so a heartbeat in
    // flight after revocation can't ride the cache to a successful auth.
    invalidateApiKeyCacheByExecRunId(body.runId);

    return NextResponse.json({ data: { revoked: result.count } });
  } catch (error) {
    return handleApiError(error);
  }
}
