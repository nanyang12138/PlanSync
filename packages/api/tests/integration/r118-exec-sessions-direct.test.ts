// R-118 [HIGH/B12]: direct tests for /api/exec-sessions/issue-token and
// /api/exec-sessions/revoke-token.
//
// These routes are the only way to mint and tear down the project-scoped
// `ps_key_exec_*` keys that gate every /exec sub-agent's writes. Existing
// suites (exec-scoped-keys.test.ts, r015-*) cover the happy path and the
// downstream "scoped key blocks owner writes" behaviour. R-118 fills the
// remaining direct-call gaps the auth model relies on:
//
//   issue-token
//     - unknown runId → 404
//     - run/taskId mismatch → 404
//     - run/projectId mismatch → 404 (cross-project mint refused)
//     - non-running run → 409 STATE_CONFLICT
//     - caller is project member but neither owner nor executor → 403
//     - caller is executor (developer role) → 201
//     - custom ttlSeconds → expiresAt honoured
//
//   revoke-token
//     - exec-scoped session may not revoke → 403
//     - revoke scoping: only keys created by the caller are deleted; the
//       returned count matches; sibling keys survive
//     - revoke invalidates the auth cache so a request that arrives after
//       revocation fails immediately instead of riding the 5-min cache
//
// Each test exercises the route handler directly (no live server) and
// asserts the persisted ApiKey state via prisma.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { POST as issuePost } from '@/app/api/exec-sessions/issue-token/route';
import { POST as revokePost } from '@/app/api/exec-sessions/revoke-token/route';
import { _resetAuthCacheForTests } from '@/lib/auth';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

describe('R-118 — exec-sessions issue / revoke direct tests', () => {
  const owner = 'r118-owner';
  const executorDev = 'r118-dev-executor';
  const outsider = 'r118-outsider-dev';

  let projectId: string;
  let otherProjectId: string;
  let planVersion: number;
  let taskId: string;
  let otherProjectTaskId: string;
  let runId: string;
  let otherProjectRunId: string;
  let completedRunId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    ({ projectId: otherProjectId } = await createTestProject(owner));

    const { version } = await createActivePlan(projectId, owner);
    planVersion = version;
    await createActivePlan(otherProjectId, owner);

    // Project A members beyond the owner: the run executor and an unrelated
    // developer used to prove that "any member" is not enough to mint a key.
    await testPrisma.projectMember.create({
      data: { projectId, name: executorDev, role: 'developer', type: 'agent' },
    });
    await testPrisma.projectMember.create({
      data: { projectId, name: outsider, role: 'developer', type: 'agent' },
    });

    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'R-118 task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: executorDev,
        assigneeType: 'agent',
        boundPlanVersion: planVersion,
        agentConstraints: [],
      },
    });
    taskId = task.id;

    // The "running" run associated with the project A task. issue-token
    // tests build their requests against this run.
    const run = await testPrisma.executionRun.create({
      data: {
        taskId,
        executorType: 'agent',
        executorName: executorDev,
        boundPlanVersion: planVersion,
        status: 'running',
        taskPackSnapshot: {},
        lastHeartbeatAt: new Date(),
        filesChanged: [],
        blockers: [],
        driftSignals: [],
      },
    });
    runId = run.id;

    // A completed run on the same task to exercise the STATE_CONFLICT
    // branch. We do not need the running run to be ended for this.
    const completedRun = await testPrisma.executionRun.create({
      data: {
        taskId,
        executorType: 'agent',
        executorName: executorDev,
        boundPlanVersion: planVersion,
        status: 'completed',
        taskPackSnapshot: {},
        filesChanged: [],
        blockers: [],
        driftSignals: [],
        endedAt: new Date(),
      },
    });
    completedRunId = completedRun.id;

    // A task + running run in a *different* project, used to confirm that
    // even a project A owner cannot mint a key for a project A request body
    // when the runId actually belongs to project B.
    const otherTask = await testPrisma.task.create({
      data: {
        projectId: otherProjectId,
        title: 'R-118 other-project task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: 1,
        agentConstraints: [],
      },
    });
    otherProjectTaskId = otherTask.id;

    const otherRun = await testPrisma.executionRun.create({
      data: {
        taskId: otherProjectTaskId,
        executorType: 'human',
        executorName: owner,
        boundPlanVersion: 1,
        status: 'running',
        taskPackSnapshot: {},
        lastHeartbeatAt: new Date(),
        filesChanged: [],
        blockers: [],
        driftSignals: [],
      },
    });
    otherProjectRunId = otherRun.id;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
    await cleanupProject(otherProjectId);
  });

  beforeEach(() => {
    // Each test starts with a clean auth cache so cache state from a
    // previous case can't leak into the assertions about cache behaviour.
    _resetAuthCacheForTests();
  });

  // ------------------------------------------------------------ issue ----

  it('issue-token: rejects unknown runId with 404 NOT_FOUND', async () => {
    const res = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        body: { runId: 'cl_does_not_exist_zzz', taskId, projectId },
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('issue-token: rejects when body.taskId does not match the run', async () => {
    // Spin up a sibling task in project A and reference it instead of the
    // task this run actually belongs to.
    const otherTask = await testPrisma.task.create({
      data: {
        projectId,
        title: 'R-118 sibling task',
        type: 'code',
        priority: 'p1',
        status: 'todo',
        assigneeType: 'agent',
        boundPlanVersion: planVersion,
        agentConstraints: [],
      },
    });

    try {
      const res = await issuePost(
        makeReq('/api/exec-sessions/issue-token', {
          method: 'POST',
          userName: owner,
          body: { runId, taskId: otherTask.id, projectId },
        }),
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('NOT_FOUND');
    } finally {
      await testPrisma.task.delete({ where: { id: otherTask.id } });
    }
  });

  it('issue-token: rejects when run lives in a different project', async () => {
    const res = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        body: { runId: otherProjectRunId, taskId: otherProjectTaskId, projectId },
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');

    // The route's authorization order matters: refusing on
    // run.task.projectId mismatch must happen before any key gets minted.
    const stored = await testPrisma.apiKey.findFirst({
      where: { execRunId: otherProjectRunId, projectId },
    });
    expect(stored).toBeNull();
  });

  it('issue-token: rejects non-running run with 409 STATE_CONFLICT', async () => {
    const res = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        body: { runId: completedRunId, taskId, projectId },
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('STATE_CONFLICT');
    expect(body.error.message).toMatch(/completed/);
  });

  it('issue-token: project member who is not owner and not executor is refused', async () => {
    const res = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: outsider,
        body: { runId, taskId, projectId },
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toMatch(/project owners or the run executor/i);
  });

  it('issue-token: run executor (non-owner developer) can mint a key', async () => {
    // Clear any pre-existing keys for the run so we can assert exactly one
    // appears below — the "one row per mint" invariant matters because
    // /exec-sessions/revoke-token relies on it.
    await testPrisma.apiKey.deleteMany({ where: { execRunId: runId } });

    const res = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: executorDev,
        body: { runId, taskId, projectId },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.key).toMatch(/^ps_key_exec_/);
    expect(body.data.execRunId).toBe(runId);

    const rows = await testPrisma.apiKey.findMany({ where: { execRunId: runId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].createdBy).toBe(executorDev);
    expect(rows[0].projectId).toBe(projectId);
    expect(rows[0].expiresAt).not.toBeNull();
  });

  it('issue-token: custom ttlSeconds is honoured on expiresAt', async () => {
    await testPrisma.apiKey.deleteMany({ where: { execRunId: runId } });

    const ttlSeconds = 300; // five minutes
    const before = Date.now();
    const res = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        body: { runId, taskId, projectId, ttlSeconds },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    const expectedExpiry = before + ttlSeconds * 1000;
    const actualExpiry = new Date(body.data.expiresAt).getTime();

    // Allow up to 30s of jitter for slow CI; the assertion that matters
    // is "much closer to ttl than to the 24h default" — the default would
    // be ~86_100_000ms above `before`, dwarfing the 30s tolerance.
    expect(Math.abs(actualExpiry - expectedExpiry)).toBeLessThan(30_000);

    const stored = await testPrisma.apiKey.findFirst({ where: { execRunId: runId } });
    expect(stored?.expiresAt?.getTime()).toBe(actualExpiry);
  });

  // ----------------------------------------------------------- revoke ----

  it('revoke-token: exec-scoped session cannot revoke its own token', async () => {
    await testPrisma.apiKey.deleteMany({ where: { execRunId: runId } });
    const issueRes = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        body: { runId, taskId, projectId },
      }),
    );
    expect(issueRes.status).toBe(201);
    const scopedKey = (await issueRes.json()).data.key as string;

    const res = await revokePost(
      makeReq('/api/exec-sessions/revoke-token', {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: { runId },
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');

    // The key row is untouched: the guard fires before deleteMany runs.
    const stillThere = await testPrisma.apiKey.count({ where: { execRunId: runId } });
    expect(stillThere).toBe(1);
  });

  it('revoke-token: only removes rows created by the caller and returns the count', async () => {
    await testPrisma.apiKey.deleteMany({ where: { execRunId: runId } });

    // Owner mints one key.
    const ownerIssue = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        body: { runId, taskId, projectId },
      }),
    );
    expect(ownerIssue.status).toBe(201);

    // The run's own executor mints a second key for the same run.
    const execIssue = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: executorDev,
        body: { runId, taskId, projectId },
      }),
    );
    expect(execIssue.status).toBe(201);

    expect(await testPrisma.apiKey.count({ where: { execRunId: runId } })).toBe(2);

    // Owner revoke must take down exactly one row (the owner's own).
    const revokeOwner = await revokePost(
      makeReq('/api/exec-sessions/revoke-token', {
        method: 'POST',
        userName: owner,
        body: { runId },
      }),
    );
    expect(revokeOwner.status).toBe(200);
    const revokeBody = await revokeOwner.json();
    expect(revokeBody.data.revoked).toBe(1);

    const remaining = await testPrisma.apiKey.findMany({ where: { execRunId: runId } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].createdBy).toBe(executorDev);

    // A second owner-revoke is now a no-op (revoked: 0) because no rows
    // match the (execRunId, createdBy: owner) filter anymore.
    const noop = await revokePost(
      makeReq('/api/exec-sessions/revoke-token', {
        method: 'POST',
        userName: owner,
        body: { runId },
      }),
    );
    expect(noop.status).toBe(200);
    expect((await noop.json()).data.revoked).toBe(0);
  });

  it('revoke-token: invalidates the auth cache so the dropped key fails immediately', async () => {
    await testPrisma.apiKey.deleteMany({ where: { execRunId: runId } });
    const issueRes = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        body: { runId, taskId, projectId },
      }),
    );
    expect(issueRes.status).toBe(201);
    const scopedKey = (await issueRes.json()).data.key as string;

    // Prime the auth cache by making a request that hits authenticate().
    // We piggy-back on issue-token's own auth check: presenting the scoped
    // key returns 403 (cannot mint from inside scoped session) but only
    // *after* verifyApiKey succeeds and caches the principal.
    const primer = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: { runId, taskId, projectId },
      }),
    );
    expect(primer.status).toBe(403);

    // Revoke deletes the row and (per R-141) the cache entry too.
    const revokeRes = await revokePost(
      makeReq('/api/exec-sessions/revoke-token', {
        method: 'POST',
        userName: owner,
        body: { runId },
      }),
    );
    expect(revokeRes.status).toBe(200);
    expect((await revokeRes.json()).data.revoked).toBe(1);

    // Now the same scoped key must fail with 401 instead of 403 — the
    // cache miss forces verifyApiKey back to the DB, which finds no row
    // and rejects the request. Without R-141's cache invalidation, this
    // call would still return 403 for up to 5 minutes.
    const afterRevoke = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        authToken: scopedKey,
        body: { runId, taskId, projectId },
      }),
    );
    expect(afterRevoke.status).toBe(401);
    const body = await afterRevoke.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });
});
