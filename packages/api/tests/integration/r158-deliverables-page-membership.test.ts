// Closes #1258: the deliverables SSR page exposes deliverables, task
// titles and per-deliverable comments. The page must refuse to render to
// anyone who is not a member of the project. The page itself is a server
// component (not directly importable as a route handler), so we exercise
// the security-critical helper it calls — `requireProjectMembershipOrNotFound`
// — end-to-end against the real DB. That guarantees the membership check
// can never silently regress without flipping at least one of these cases
// red.
//
// Coverage index for adjacent issues that target the same helper, so future
// grep-by-issue lands in the right place instead of re-adding duplicate
// `describe` blocks (which is exactly what produced the must-severity
// JSDoc-opener syntax error reported in #1628 against PR #1315):
//   - #1287 (R-137 / SSR scoped-key cross-project boundary, fixed by PR
//     #1314) — covered by the `Issue #1287: SSR membership helper enforces
//     API-key project / exec scope` describe below; that block already
//     exercises cross-project block, same-project allow, exec-scoped block,
//     dirty-data (execRunId without projectId) block, and unscoped allow.
//   - #1293 (re-report of the same scoped-key cross-project boundary)
//     resolves to the SAME helper change shipped by PR #1314 and is fully
//     covered by the #1287 describe above. No additional describe block is
//     needed — adding one would just duplicate every assertion verbatim.
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  createTestProject,
  addMember,
  cleanupProject,
  createActivePlan,
  testPrisma,
} from '../helpers/request';

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

/**
 * Closes #1287: the SSR membership helper must enforce the API key's
 * own project / exec scope, not just `(projectId, userName)` membership.
 * A project-scoped or exec-scoped `ps_key_*` cookie issued for project
 * A must not unlock SSR rendering of project B — even when the same
 * user happens to be a member of both projects. We exercise the helper
 * directly against the real DB because that is exactly the surface the
 * deliverables server component calls.
 */
async function mintApiKeyRow(opts: {
  prefixSeed: string;
  createdBy: string;
  projectId: string | null;
  execRunId?: string | null;
}) {
  const rawKey = `ps_key_i1287_${opts.prefixSeed}_${crypto.randomBytes(16).toString('hex')}`;
  const keyPrefix = rawKey.slice(0, 15);
  const salt = crypto.randomBytes(16);
  const keyHash = await new Promise<string>((resolve, reject) => {
    crypto.scrypt(rawKey, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(salt.toString('hex') + ':' + derivedKey.toString('hex'));
    });
  });
  const row = await testPrisma.apiKey.create({
    data: {
      projectId: opts.projectId,
      name: `i1287-${opts.prefixSeed}`,
      keyHash,
      keyPrefix,
      permissions: ['read', 'write'],
      createdBy: opts.createdBy,
      ...(opts.execRunId ? { execRunId: opts.execRunId } : {}),
    },
  });
  return { rawKey, id: row.id };
}

describe('Issue #1287: SSR membership helper enforces API-key project / exec scope', () => {
  const sharedUser = `i1287-user-${Date.now()}`;
  let projectAId: string;
  let projectBId: string;
  let execRunId: string;
  const createdKeyIds: string[] = [];

  beforeAll(async () => {
    // Same user owns both projects so a plain `(projectId, userName)`
    // membership check would happily approve cross-project rendering.
    // The fix MUST refuse based on the key's own scope.
    ({ projectId: projectAId } = await createTestProject(sharedUser));
    ({ projectId: projectBId } = await createTestProject(sharedUser));

    // A real ExecutionRun under project A so the FK on
    // ApiKey.execRunId is satisfied for the exec-scoped key case.
    const { version } = await createActivePlan(projectAId, sharedUser);
    const task = await testPrisma.task.create({
      data: {
        projectId: projectAId,
        title: 'i1287 host',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: sharedUser,
        assigneeType: 'human',
        boundPlanVersion: version,
        agentConstraints: [],
      },
    });
    const run = await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        executorType: 'human',
        executorName: sharedUser,
        boundPlanVersion: version,
        status: 'running',
        taskPackSnapshot: {},
        lastHeartbeatAt: new Date(),
        filesChanged: [],
        blockers: [],
        driftSignals: [],
      },
    });
    execRunId = run.id;
  });

  afterAll(async () => {
    if (createdKeyIds.length > 0) {
      await testPrisma.apiKey.deleteMany({ where: { id: { in: createdKeyIds } } });
    }
    await cleanupProject(projectAId);
    await cleanupProject(projectBId);
  });

  beforeEach(() => {
    cookieJar.clear();
  });

  it('project-scoped key for project A → notFound() when rendering project B (even though same user is a member of B)', async () => {
    const { rawKey, id } = await mintApiKeyRow({
      prefixSeed: 'scoped',
      createdBy: sharedUser,
      projectId: projectAId,
    });
    createdKeyIds.push(id);

    cookieJar.set('plansync-apikey', rawKey);

    await expect(() => requireProjectMembershipOrNotFound(projectBId)).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );
  });

  it('project-scoped key for project A → still renders project A (regression — scope must match, not block)', async () => {
    const { rawKey, id } = await mintApiKeyRow({
      prefixSeed: 'scoped-home',
      createdBy: sharedUser,
      projectId: projectAId,
    });
    createdKeyIds.push(id);

    cookieJar.set('plansync-apikey', rawKey);

    const result = await requireProjectMembershipOrNotFound(projectAId);
    expect(result).toEqual({ userName: sharedUser, role: 'owner' });
  });

  it('exec-scoped key (projectId + execRunId, both for project A) → notFound() against project B', async () => {
    const { rawKey, id } = await mintApiKeyRow({
      prefixSeed: 'exec',
      createdBy: sharedUser,
      projectId: projectAId,
      execRunId,
    });
    createdKeyIds.push(id);

    cookieJar.set('plansync-apikey', rawKey);

    await expect(() => requireProjectMembershipOrNotFound(projectBId)).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );
  });

  it('dirty-data key (execRunId set, no projectId) → notFound() for any project', async () => {
    const { rawKey, id } = await mintApiKeyRow({
      prefixSeed: 'dirty',
      createdBy: sharedUser,
      projectId: null,
      execRunId,
    });
    createdKeyIds.push(id);

    cookieJar.set('plansync-apikey', rawKey);

    await expect(() => requireProjectMembershipOrNotFound(projectAId)).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );
  });

  it('unscoped key (no projectId, no execRunId) → still gated by membership only (no false positives)', async () => {
    // A regular non-scoped key from the same user must keep working
    // against any project they are a member of. This guards against
    // overshooting the fix and rejecting all API-key SSR access.
    const { rawKey, id } = await mintApiKeyRow({
      prefixSeed: 'unscoped',
      createdBy: sharedUser,
      projectId: null,
    });
    createdKeyIds.push(id);

    cookieJar.set('plansync-apikey', rawKey);

    const result = await requireProjectMembershipOrNotFound(projectBId);
    expect(result).toEqual({ userName: sharedUser, role: 'owner' });
  });
});
