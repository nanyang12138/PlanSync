// R-115: integration coverage for GET /api/projects/:projectId/tasks/conflicts.
//
// The route delegates conflict analysis to predictConflicts(), which short-
// circuits in three places:
//   1. AI client not configured  -> returns null  -> route emits a 200 body
//      with `conflicts: []` and an "AI not available" hint message.
//   2. Fewer than two active tasks -> returns `{ conflicts: [] }` without
//      calling the AI.
//   3. Otherwise it consults the AI provider, which CI never has keys for.
//
// Before this test the conflicts endpoint had zero direct coverage: nothing
// guarded against regressions in auth (cross-project leak), the
// "AI unavailable" envelope (CLI surfaces the `message` to the user), or
// the implicit `status in (in_progress, todo, blocked)` filter that decides
// which rows are even handed to the predictor. These three behaviours are
// the user-visible contract; the AI call itself stays out of scope so the
// suite stays runnable on the default CI matrix (no LLM_API_KEY /
// ANTHROPIC_API_KEY).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// vi.mock is hoisted before module imports so the route picks up the stub.
vi.mock('@/lib/ai/conflict-prediction', () => ({
  predictConflicts: vi.fn(),
}));

import { GET as conflictsGet } from '@/app/api/projects/[projectId]/tasks/conflicts/route';
import { predictConflicts } from '@/lib/ai/conflict-prediction';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  addMember,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

const mockedPredictConflicts = vi.mocked(predictConflicts);

describe('R-115: GET /tasks/conflicts integration', () => {
  const owner = 'r115-owner';
  const dev = 'r115-dev';
  const outsider = 'r115-outsider';
  let projectId: string;
  let planVersion: number;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, dev);
    const plan = await createActivePlan(projectId, owner);
    planVersion = plan.version;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  beforeEach(() => {
    mockedPredictConflicts.mockReset();
  });

  async function createTask(
    title: string,
    status: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled',
    assignee?: string,
  ) {
    return testPrisma.task.create({
      data: {
        projectId,
        title,
        type: 'code',
        priority: 'p1',
        status,
        boundPlanVersion: planVersion,
        ...(assignee ? { assignee, assigneeType: 'human' as const } : {}),
      },
    });
  }

  it('rejects non-members with 403 (cross-project leak guard)', async () => {
    const res = await conflictsGet(
      makeReq(`/api/projects/${projectId}/tasks/conflicts`, { userName: outsider }),
      { params: { projectId } },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
    // The predictor must never run when authorization fails — the AI call
    // is expensive and would leak project task metadata into the prompt.
    expect(mockedPredictConflicts).not.toHaveBeenCalled();
  });

  it('returns 200 with empty conflicts + AI-unavailable hint when predictor returns null', async () => {
    // Two in-progress tasks exist; predictConflicts() returning null mirrors
    // the production no-AI-keys path. The CLI relies on the hint text to
    // tell the user how to enable conflict prediction.
    await createTask('R-115 in_progress A', 'in_progress', owner);
    await createTask('R-115 in_progress B', 'in_progress', dev);

    mockedPredictConflicts.mockResolvedValueOnce(null);

    const res = await conflictsGet(
      makeReq(`/api/projects/${projectId}/tasks/conflicts`, { userName: owner }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ conflicts: [] });
    expect(body.message).toMatch(/AI not available/i);
    expect(body.message).toMatch(/LLM_API_KEY|ANTHROPIC_API_KEY/);
    expect(mockedPredictConflicts).toHaveBeenCalledTimes(1);

    const forwarded = mockedPredictConflicts.mock.calls[0]?.[0] as Array<{
      title: string;
      status: string;
    }>;
    expect(forwarded.map((t) => t.title).sort()).toEqual([
      'R-115 in_progress A',
      'R-115 in_progress B',
    ]);
  });

  it('returns AI-provided conflicts verbatim when the predictor resolves them', async () => {
    const stubbed = {
      conflicts: [
        {
          taskIds: ['t1', 't2'],
          type: 'shared_file',
          severity: 'high',
          description: 'Both tasks edit shared/auth.ts',
          recommendation: 'Sequence the work',
        },
      ],
    };
    mockedPredictConflicts.mockResolvedValueOnce(stubbed);

    const res = await conflictsGet(
      makeReq(`/api/projects/${projectId}/tasks/conflicts`, { userName: owner }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(stubbed);
    expect(body.message).toBeUndefined();
    expect(mockedPredictConflicts).toHaveBeenCalledTimes(1);
  });

  it('filters out done/cancelled tasks before calling the predictor', async () => {
    // Active set in the project so far: 2 x in_progress (from earlier test).
    // Add one done + one cancelled + one fresh todo; only the todo should
    // join the in_progress pair when forwarded to predictConflicts.
    await createTask('R-115 done (must be excluded)', 'done');
    await createTask('R-115 cancelled (must be excluded)', 'cancelled');
    await createTask('R-115 todo (must be included)', 'todo', dev);

    mockedPredictConflicts.mockResolvedValueOnce({ conflicts: [] });

    const res = await conflictsGet(
      makeReq(`/api/projects/${projectId}/tasks/conflicts`, { userName: owner }),
      { params: { projectId } },
    );
    expect(res.status).toBe(200);

    const forwarded = mockedPredictConflicts.mock.calls[0]?.[0] as Array<{
      title: string;
      status: string;
    }>;
    const statuses = forwarded.map((t) => t.status).sort();
    expect(statuses).toEqual(['in_progress', 'in_progress', 'todo']);
    expect(forwarded.some((t) => t.title.includes('done'))).toBe(false);
    expect(forwarded.some((t) => t.title.includes('cancelled'))).toBe(false);
  });
});
