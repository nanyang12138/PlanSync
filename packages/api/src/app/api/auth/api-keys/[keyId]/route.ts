import { NextRequest, NextResponse } from 'next/server';
import { AppError, ErrorCode } from '@plansync/shared';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';
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
    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    return handleApiError(error);
  }
}
