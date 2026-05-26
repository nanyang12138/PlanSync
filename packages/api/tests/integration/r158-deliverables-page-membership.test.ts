// Closes #1258: the deliverables SSR page exposes deliverables, task
// titles and per-deliverable comments. The page must refuse to render to
// anyone who is not a member of the project. The page itself is a server
// component (not directly importable as a route handler), so we exercise
// the security-critical helper it calls — `requireProjectMembershipOrNotFound`
// — end-to-end against the real DB. That guarantees the membership check
// can never silently regress without flipping at least one of these cases
// red.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestProject, addMember, cleanupProject } from '../helpers/request';

// `next/headers.cookies()` is only valid inside the Next.js server runtime;
// in vitest we replace it with a mutable fake cookie jar so each test can
// pretend to be a different signed-in user.
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

// `notFound()` normally throws an internal Next.js sentinel; here we
// throw a sentinel error we can assert against from tests.
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

import { requireProjectMembershipOrNotFound } from '@/lib/ssr-auth';

describe('R-158 / #1258: deliverables page enforces project membership at SSR', () => {
  const owner = `r158-owner-${Date.now()}`;
  const developer = `r158-dev-${Date.now()}`;
  const outsider = `r158-outsider-${Date.now()}`;
  let projectId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    await addMember(projectId, developer, 'developer');
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  beforeEach(() => {
    cookieJar.clear();
  });

  it('owner cookie → returns membership row', async () => {
    cookieJar.set('plansync-user', owner);
    const result = await requireProjectMembershipOrNotFound(projectId);
    expect(result).toEqual({ userName: owner, role: 'owner' });
  });

  it('member developer cookie → returns membership row', async () => {
    cookieJar.set('plansync-user', developer);
    const result = await requireProjectMembershipOrNotFound(projectId);
    expect(result).toEqual({ userName: developer, role: 'developer' });
  });

  it('non-member cookie → notFound() (does NOT leak deliverables/tasks/comments)', async () => {
    cookieJar.set('plansync-user', outsider);
    await expect(() => requireProjectMembershipOrNotFound(projectId)).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );
  });

  it('no cookie at all → notFound() (no anonymous read of project content)', async () => {
    // cookieJar is empty; resolveCurrentUserName falls through every
    // branch except the AUTH_DISABLED env.USER fallback. Setup runs
    // with AUTH_DISABLED=true, so we explicitly null PLANSYNC_USER /
    // USER for this test to simulate an unauthenticated browser hitting
    // the page directly.
    const prevPlanSyncUser = process.env.PLANSYNC_USER;
    const prevUser = process.env.USER;
    delete process.env.PLANSYNC_USER;
    delete process.env.USER;
    try {
      await expect(() => requireProjectMembershipOrNotFound(projectId)).rejects.toBeInstanceOf(
        NotFoundSentinel,
      );
    } finally {
      if (prevPlanSyncUser !== undefined) process.env.PLANSYNC_USER = prevPlanSyncUser;
      if (prevUser !== undefined) process.env.USER = prevUser;
    }
  });
});
