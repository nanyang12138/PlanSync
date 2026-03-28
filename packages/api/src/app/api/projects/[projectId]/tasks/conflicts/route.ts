import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { predictConflicts } from '@/lib/ai/conflict-prediction';

type Params = { params: { projectId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const tasks = await prisma.task.findMany({
      where: {
        projectId: params.projectId,
        status: { in: ['in_progress', 'todo', 'blocked'] },
      },
    });

    const result = await predictConflicts(tasks);
    if (!result) {
      return NextResponse.json({
        data: { conflicts: [] },
        message: 'AI not available. Set LLM_API_KEY (internal) or ANTHROPIC_API_KEY to enable.',
      });
    }

    return NextResponse.json({ data: result });
  } catch (error) {
    return handleApiError(error);
  }
}
