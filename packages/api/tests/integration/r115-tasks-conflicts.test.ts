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
//
// #140 / #141 follow-up: each test owns its own task fixtures and cleans
// up afterwards. Previously the "filters out" case relied on tasks
// inserted by an earlier test, which meant `vitest -t "filters out"`
// (running that case in isolation) would silently see 0 active tasks and
// the 'in_progress' assertions would no longer be meaningful. The same
// shared-state habit was hiding a missing `blocked` case — the route
// contract says `status in (in_progress, todo, blocked)` is forwarded,
// but no fixture ever inserted a `blocked` row, so a regression that
// silently dropped `blocked` from the predicate would not have failed
// the suite. Both gaps are now closed.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

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

  // Each test rebuilds its own fixtures. Without this hook the order in
  // which vitest resolves tests inside the file determined whether the
  // "filters" case had any in_progress rows to forward — running
  // `-t "filters out"` in isolation would silently drop the 'in_progress'
  // expectation. (#140)
  beforeEach(async () => {
    mockedPredictConflicts.mockReset();
    await testPrisma.task.deleteMany({ where: { projectId } });
  });

  afterEach(async () => {
    await testPrisma.task.deleteMany({ where: { projectId } });
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
      { params: Promise.resolve({ projectId }) },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
    // The predictor must never run when authorization fails — the AI call
    // is expensive and would leak project task metadata into the prompt.
    expect(mockedPredictConflicts).not.toHaveBeenCalled();
  });

  it('returns 200 with empty conflicts + AI-unavailable hint when predictor returns null', async () => {
    // Self-contained fixtures so the test can be run in isolation
    // (`vitest -t "AI-unavailable"`) without depending on prior cases. (#140)
    await createTask('R-115 in_progress A', 'in_progress', owner);
    await createTask('R-115 in_progress B', 'in_progress', dev);

    mockedPredictConflicts.mockResolvedValueOnce(null);

    const res = await conflictsGet(
      makeReq(`/api/projects/${projectId}/tasks/conflicts`, { userName: owner }),
      { params: Promise.resolve({ projectId }) },
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
    // Self-contained: at least 2 active tasks so the route does not
    // short-circuit in predictConflicts(). (#140)
    await createTask('R-115 verbatim A', 'in_progress', owner);
    await createTask('R-115 verbatim B', 'in_progress', dev);

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
      { params: Promise.resolve({ projectId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual(stubbed);
    expect(body.message).toBeUndefined();
    expect(mockedPredictConflicts).toHaveBeenCalledTimes(1);
  });

  it('filters out done/cancelled tasks and includes blocked/todo/in_progress before calling the predictor', async () => {
    // The route's contract is `status in (in_progress, todo, blocked)`. We
    // create one of each so a regression that silently drops any of the
    // three (or starts including done/cancelled) fails this case loudly.
    // Two in_progress tasks are needed so we cover the "common case" path
    // alongside the contract assertion. (#140 self-contained, #141 covers
    // blocked.)
    await createTask('R-115 in_progress A', 'in_progress', owner);
    await createTask('R-115 in_progress B', 'in_progress', dev);
    await createTask('R-115 todo (must be included)', 'todo', dev);
    await createTask('R-115 blocked (must be included)', 'blocked', owner);
    await createTask('R-115 done (must be excluded)', 'done');
    await createTask('R-115 cancelled (must be excluded)', 'cancelled');

    mockedPredictConflicts.mockResolvedValueOnce({ conflicts: [] });

    const res = await conflictsGet(
      makeReq(`/api/projects/${projectId}/tasks/conflicts`, { userName: owner }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(res.status).toBe(200);

    const forwarded = mockedPredictConflicts.mock.calls[0]?.[0] as Array<{
      title: string;
      status: string;
    }>;

    const statuses = forwarded.map((t) => t.status).sort();
    expect(statuses).toEqual(['blocked', 'in_progress', 'in_progress', 'todo']);

    // Belt-and-braces: assert the active triple is each present at least
    // once; if a future refactor reorders or de-duplicates the predicate
    // the per-status check pinpoints which one slipped.
    expect(forwarded.some((t) => t.status === 'blocked')).toBe(true);
    expect(forwarded.some((t) => t.status === 'todo')).toBe(true);
    expect(forwarded.some((t) => t.status === 'in_progress')).toBe(true);

    expect(forwarded.some((t) => t.title.includes('done'))).toBe(false);
    expect(forwarded.some((t) => t.title.includes('cancelled'))).toBe(false);
  });

  it('R-115 #141: a blocked-only project still forwards the rows to the predictor', async () => {
    // Dedicated regression test for the case the contract says is allowed
    // but no other case ever exercises in isolation: a project where the
    // only active rows are `blocked`. If the route ever drops 'blocked'
    // from its `status: { in: [...] }` predicate, this case fails.
    await createTask('R-115 blocked-only A', 'blocked', owner);
    await createTask('R-115 blocked-only B', 'blocked', dev);

    mockedPredictConflicts.mockResolvedValueOnce({ conflicts: [] });

    const res = await conflictsGet(
      makeReq(`/api/projects/${projectId}/tasks/conflicts`, { userName: owner }),
      { params: Promise.resolve({ projectId }) },
    );
    expect(res.status).toBe(200);
    expect(mockedPredictConflicts).toHaveBeenCalledTimes(1);

    const forwarded = mockedPredictConflicts.mock.calls[0]?.[0] as Array<{
      title: string;
      status: string;
    }>;
    expect(forwarded.map((t) => t.status)).toEqual(['blocked', 'blocked']);
  });
});
