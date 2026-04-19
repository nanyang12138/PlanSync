import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const auth = await authenticate(req);
    const now = new Date();

    let timestamp = now;
    try {
      const body = (await req.json()) as { at?: string } | null;
      if (body?.at) {
        const parsed = new Date(body.at);
        if (!Number.isNaN(parsed.getTime())) timestamp = parsed;
      }
    } catch {
      // empty body is fine — default to now
    }

    await prisma.userState.upsert({
      where: { userName: auth.userName },
      update: { lastSeenActivityAt: timestamp },
      create: { userName: auth.userName, lastSeenActivityAt: timestamp },
    });

    return NextResponse.json({ lastSeenActivityAt: timestamp });
  } catch (error) {
    return handleApiError(error);
  }
}
