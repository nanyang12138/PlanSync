// Closes #1289: the deliverables SSR page must fail closed when `?plan=` is
// supplied but does not identify a plan that belongs to this project. The
// previous truthy guard (`searchParams.plan && allPlans.some(...)`) silently
// fell back to the active/latest plan whenever `?plan=` was empty (e.g.
// `…/deliverables?plan=`) or didn't match any plan id, including ids that
// belonged to other projects — letting users believe they were
// reading/commenting on the plan named in the URL while the page actually
// rendered something else.
//
// We exercise the real page Server Component end-to-end against the DB so
// the guard cannot silently regress. We mock `next/headers` so the page can
// "log in" as the project owner, and `next/navigation` so `notFound()`
// throws a sentinel that vitest can match on.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
    this.name = 'NotFoundSentinel';
  }
}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundSentinel();
  },
}));

import ProjectDeliverablesPage from '@/app/projects/[id]/plans/deliverables/page';

async function callPage(projectId: string, searchParams: { plan?: string }) {
  return ProjectDeliverablesPage({
    params: Promise.resolve({ id: projectId }),
    searchParams: Promise.resolve(searchParams),
  });
}

describe('R-156 / #1289: deliverables page rejects invalid ?plan= URLs (fail-closed)', () => {
  const owner = `r1289-owner-${Date.now()}`;
  const otherOwner = `r1289-other-${Date.now()}`;
  let projectId: string;
  let otherProjectId: string;
  let validPlanId: string;
  let otherProjectPlanId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    ({ planId: validPlanId } = await createActivePlan(projectId, owner));

    ({ projectId: otherProjectId } = await createTestProject(otherOwner));
    ({ planId: otherProjectPlanId } = await createActivePlan(otherProjectId, otherOwner));
  });

  afterAll(async () => {
    await cleanupProject(projectId);
    await cleanupProject(otherProjectId);
  });

  beforeEach(() => {
    cookieJar.clear();
    cookieJar.set('plansync-user', owner);
  });

  // The two happy-path cases assert that the guard does NOT trip. The page
  // returns JSX, which vitest's plain-node runtime can't actually render
  // (no JSX runtime), so we treat any non-NotFoundSentinel outcome —
  // whether the call resolves or throws a downstream rendering error —
  // as proof that the fail-closed guard let the request through. The
  // dedicated negative tests below assert the guard DOES trip when it
  // should.
  async function expectGuardLetThrough(searchParams: { plan?: string }) {
    try {
      await callPage(projectId, searchParams);
    } catch (err) {
      expect(err).not.toBeInstanceOf(NotFoundSentinel);
    }
  }

  it('omitted ?plan= → guard lets through (active-plan default)', async () => {
    await expectGuardLetThrough({});
  });

  it('?plan=<valid id in this project> → guard lets through', async () => {
    await expectGuardLetThrough({ plan: validPlanId });
  });

  it('?plan= (empty string) → notFound() (#1289 — truthy guard regression)', async () => {
    // The bug: an empty-string `?plan=` is falsy, so `searchParams.plan && …`
    // short-circuits past the guard and the page silently falls back to the
    // active plan (or renders "No plan to render"). With the fix, an
    // explicit empty string is "supplied-but-invalid" and must 404.
    await expect(() => callPage(projectId, { plan: '' })).rejects.toBeInstanceOf(NotFoundSentinel);
  });

  it('?plan=<non-existent id> → notFound()', async () => {
    await expect(() =>
      callPage(projectId, { plan: 'plan-id-that-does-not-exist' }),
    ).rejects.toBeInstanceOf(NotFoundSentinel);
  });

  it('?plan=<plan id from another project> → notFound() (cross-project guard)', async () => {
    // Sanity-check: the other project's plan really exists. If this
    // assertion ever fails, the test below is suddenly "passing" for the
    // wrong reason (id genuinely doesn't exist anywhere) — make that
    // visible.
    const exists = await testPrisma.plan.findUnique({
      where: { id: otherProjectPlanId },
      select: { id: true },
    });
    expect(exists).not.toBeNull();

    await expect(() => callPage(projectId, { plan: otherProjectPlanId })).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );
  });
});
