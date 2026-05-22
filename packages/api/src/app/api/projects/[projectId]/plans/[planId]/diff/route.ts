import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { authenticate, requireProjectRole } from '@/lib/auth';
import { handleApiError } from '@/lib/errors';
import { getOrCreatePlanDiff } from '@/lib/ai/plan-diff';
import { requirePlanInProject } from '@/lib/plan-scope';

type Params = { params: { projectId: string; planId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await authenticate(req);
    await requireProjectRole(auth, params.projectId);

    const compareWithParam = req.nextUrl.searchParams.get('compareWith');
    let compareWith = compareWithParam;
    if (!compareWith) {
      const currentPlan = await requirePlanInProject(params.planId, params.projectId);
      if (currentPlan.version <= 1) {
        return NextResponse.json({
          data: {
            changes: [],
            summary: 'First version — no predecessor to diff against',
            breakingChanges: false,
          },
        });
      }
      const predecessor = await prisma.plan.findUnique({
        where: {
          projectId_version: { projectId: params.projectId, version: currentPlan.version - 1 },
        },
      });
      if (!predecessor) {
        return NextResponse.json({
          data: {
            changes: [],
            summary: 'No predecessor found to diff against',
            breakingChanges: false,
          },
        });
      }
      compareWith = predecessor.id;
    }

    // Both plans must belong to the project; collapse missing/wrong-project
    // into the same NOT_FOUND so callers cannot probe for cross-project plans.
    await Promise.all([
      requirePlanInProject(compareWith, params.projectId),
      requirePlanInProject(params.planId, params.projectId),
    ]);

    const diff = await getOrCreatePlanDiff(params.projectId, compareWith, params.planId);
    if (!diff) {
      return NextResponse.json({
        data: null,
        message:
          'AI not available or plans not found. Set LLM_API_KEY (internal) or ANTHROPIC_API_KEY to enable.',
      });
    }

    return NextResponse.json({ data: diff });
  } catch (error) {
    return handleApiError(error);
  }
}
