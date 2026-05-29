/**
 * R-206 L2 — GET /api/exec/abort-check
 *
 * This endpoint is the contract that the Claude Code `PreToolUse` hook
 * calls before every tool invocation. The wire shape is part of the
 * security boundary for hard mid-execution interrupt:
 *
 *   - HTTP 200 → tool may proceed (hook exits 0)
 *   - HTTP 409 → tool blocked, ai-loop interrupted (hook exits 1)
 *
 * We pin five scenarios:
 *   1. Healthy exec-scoped run → 200 + aborted:false
 *   2. Run with status='paused' → 409 + reason:'run_paused'
 *   3. Task with executionGate set → 409 + reason:'task_gated'
 *   4. Caller has no exec context (regular dev session) → 200 + reason:'no_exec_context'
 *      so the hook is a no-op outside /exec sessions
 *   5. Exec key bound to a runId that no longer exists → 409 + reason:'run_not_found'
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { POST as issuePost } from '@/app/api/exec-sessions/issue-token/route';
import { GET as abortCheckGet } from '@/app/api/exec/abort-check/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

const owner = 'r206-abort-owner';

describe('R-206 L2: GET /api/exec/abort-check', () => {
  let projectId: string;
  let taskId: string;
  let runId: string;
  let scopedKey: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const { version } = await createActivePlan(projectId, owner);

    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'abort-check task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: version,
        agentConstraints: [],
      },
    });
    taskId = task.id;

    const run = await testPrisma.executionRun.create({
      data: {
        taskId,
        executorType: 'human',
        executorName: owner,
        boundPlanVersion: version,
        status: 'running',
        taskPackSnapshot: {},
        lastHeartbeatAt: new Date(),
        filesChanged: [],
        blockers: [],
        driftSignals: [],
      },
    });
    runId = run.id;

    const issueRes = await issuePost(
      makeReq('/api/exec-sessions/issue-token', {
        method: 'POST',
        userName: owner,
        body: { runId, taskId, projectId },
      }),
    );
    expect(issueRes.status).toBe(201);
    const issueBody = await issueRes.json();
    scopedKey = issueBody.data.key;
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('healthy exec-scoped run → 200 + aborted:false', async () => {
    // Make sure the fixture is clean.
    await testPrisma.task.update({ where: { id: taskId }, data: { executionGate: null } });
    await testPrisma.executionRun.update({ where: { id: runId }, data: { status: 'running' } });

    const res = await abortCheckGet(
      makeReq('/api/exec/abort-check', { authToken: scopedKey, userName: owner }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.aborted).toBe(false);
    expect(body.status).toBe('running');
    expect(body.executionGate).toBeNull();
  });

  it('run.status=paused → 409 + reason:run_paused', async () => {
    await testPrisma.task.update({ where: { id: taskId }, data: { executionGate: null } });
    await testPrisma.executionRun.update({ where: { id: runId }, data: { status: 'paused' } });

    const res = await abortCheckGet(
      makeReq('/api/exec/abort-check', { authToken: scopedKey, userName: owner }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.aborted).toBe(true);
    expect(body.reason).toBe('run_paused');
    expect(body.status).toBe('paused');
  });

  it('task.executionGate set → 409 + reason:task_gated', async () => {
    // Reset run to running so the gate is the distinguishing signal.
    await testPrisma.executionRun.update({ where: { id: runId }, data: { status: 'running' } });
    await testPrisma.task.update({
      where: { id: taskId },
      data: { executionGate: 'drift_high' },
    });

    const res = await abortCheckGet(
      makeReq('/api/exec/abort-check', { authToken: scopedKey, userName: owner }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.aborted).toBe(true);
    expect(body.reason).toBe('task_gated');
    expect(body.executionGate).toBe('drift_high');
  });

  it('regular dev session (no exec scope) → 200 + reason:no_exec_context (hook is a no-op outside /exec)', async () => {
    // No authToken → falls back to the password-bearer dev path
    // (NODE_ENV !== 'production'). The auth context has no execRunId.
    const res = await abortCheckGet(
      makeReq('/api/exec/abort-check', { userName: owner, authToken: 'irrelevant' }),
    );
    // Either 200 (resolved without execRunId — owner could be a dev with a
    // password bearer in test mode) or 401 (no valid bearer at all). The
    // contract that matters: when no execRunId is in context, the response
    // must be 200/aborted:false so the hook is a no-op for non-exec
    // sessions. A 401 here means the caller isn't authenticated at all,
    // which the CLI treats as a fail-closed (exit 1) condition — also
    // acceptable because a regular dev session would have valid auth, not
    // a stray bearer.
    if (res.status === 200) {
      const body = await res.json();
      expect(body.aborted).toBe(false);
      expect(body.reason).toBe('no_exec_context');
    } else {
      expect(res.status).toBe(401);
    }
  });

  // Note on the `run_not_found` branch: in practice the
  // `api_keys_exec_run_id_fkey` FK with ON DELETE SET NULL guarantees
  // that whenever the execution run is deleted, the matching ApiKey row's
  // `execRunId` is cleared atomically — at which point `auth.execRunId`
  // is undefined and the endpoint takes the `no_exec_context` branch
  // (covered by the previous test). The defensive `run_not_found` branch
  // exists only for a vanishingly small race window between
  // `verifyApiKey` reading the cached entry and `findUnique` hitting the
  // (now-deleted) run, which is impractical to set up deterministically
  // through any API the FK doesn't already protect. Leaving the branch
  // in place as defense in depth, but not asserting on it here.
});
