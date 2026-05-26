import { NextRequest, NextResponse } from 'next/server';
import { AppError, ErrorCode } from '@plansync/shared';
import { prisma } from '@/lib/prisma';
import { authenticate, invalidateApiKeyCacheByApiKeyId } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';

type Params = { params: Promise<{ keyId: string }> };

export async function DELETE(req: NextRequest, __nextCtx: Params) {
  const params = await __nextCtx.params;
  try {
    const auth = await authenticate(req);
    const key = await prisma.apiKey.findUnique({ where: { id: params.keyId } });
    if (!key)
      return NextResponse.json({ error: { message: 'API key not found' } }, { status: 404 });

    if (key.createdBy !== auth.userName) {
      throw new AppError(ErrorCode.FORBIDDEN, 'You can only revoke your own API keys');
    }

    await prisma.apiKey.delete({ where: { id: params.keyId } });

    // Closes #741 — pre-fix the cache kept the principal alive for
    // up to AUTH_CACHE_TTL_MS (5 min) after the row was deleted, so
    // a revoked key continued to authenticate. Other revocation
    // paths (password change, exec-session revoke) already call
    // their respective invalidate helpers; this one was missed.
    // Drop every cached entry keyed off this apiKeyId so the next
    // request re-verifies against the now-empty DB row and returns
    // 401 (the inline TTL guard at auth.ts L229 only covers
    // expiresAt, not row deletion).
    invalidateApiKeyCacheByApiKeyId(params.keyId);

    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    return handleApiError(error);
  }
}
