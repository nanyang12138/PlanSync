// R-137: an API key that carries a `projectId` (project scope) MUST be
// rejected when used against any other project — even if the key has no
// `execRunId`. Before R-137, requireProjectRole only enforced cross-project
// rejection when BOTH execRunId AND keyProjectId were set (`A && B && ...`).
// Legacy rows minted with projectId-but-no-execRunId (e.g. older seeds,
// hand-crafted audit rows, or migrated data predating R-011) silently
// granted cross-project access. R-137 splits the check so projectId scope
// is always enforced, and additionally rejects execRunId-without-projectId
// as dirty data.
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GET as tasksGet } from '@/app/api/projects/[projectId]/tasks/route';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

/**
 * Mint a raw ps_key_* token and the matching scrypt hash so we can persist
 * an ApiKey row directly and then authenticate as that key in tests. We
 * have to do this manually because the /exec-sessions/issue-token route
 * always sets both projectId AND execRunId — exactly the safe path R-137
 * codifies. Here we want to construct the *legacy* unsafe shapes.
 */
async function mintKey(prefixSeed: string) {
  const rawKey = `ps_key_r137_${prefixSeed}_${crypto.randomBytes(16).toString('hex')}`;
  const keyPrefix = rawKey.slice(0, 15);
  const salt = crypto.randomBytes(16);
  const keyHash = await new Promise<string>((resolve, reject) => {
    crypto.scrypt(rawKey, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(salt.toString('hex') + ':' + derivedKey.toString('hex'));
    });
  });
  return { rawKey, keyPrefix, keyHash };
}

describe('R-137: project-scoped key without execRunId still enforces project boundary', () => {
  const owner = 'r137-owner';
  let projectAId: string;
  let projectBId: string;
  let runId: string;
  const createdKeyIds: string[] = [];

  beforeAll(async () => {
    // Two sibling projects where the same user is owner. The cross-project
    // check must NOT lean on membership — even valid members of project B
    // cannot use a key scoped to project A.
    ({ projectId: projectAId } = await createTestProject(owner));
    ({ projectId: projectBId } = await createTestProject(owner));
    const { version } = await createActivePlan(projectAId, owner);

    // Real execution run we can reuse for the FK in the dirty-data case.
    // We create it under project A so the FK on ApiKey.execRunId is
    // satisfied; the test cares about what auth.ts does with the resulting
    // mismatched key, not about the run itself.
    const task = await testPrisma.task.create({
      data: {
        projectId: projectAId,
        title: 'R-137 host task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: version,
        agentConstraints: [],
      },
    });
    const run = await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
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
  });

  afterAll(async () => {
    if (createdKeyIds.length > 0) {
      await testPrisma.apiKey.deleteMany({ where: { id: { in: createdKeyIds } } });
    }
    await cleanupProject(projectAId);
    await cleanupProject(projectBId);
  });

  it('rejects a projectId-bound key (no execRunId) when used against a sibling project', async () => {
    // Build the *exact* shape R-137 closes: projectId set, execRunId null.
    // Pre-R-137 requireProjectRole would short-circuit on `auth.execRunId &&`
    // and let this through.
    const { rawKey, keyPrefix, keyHash } = await mintKey('legacy');
    const row = await testPrisma.apiKey.create({
      data: {
        projectId: projectAId,
        name: 'r137-legacy-project-key',
        keyHash,
        keyPrefix,
        permissions: ['read', 'write'],
        createdBy: owner,
        // intentionally NO execRunId
      },
    });
    createdKeyIds.push(row.id);

    const res = await tasksGet(
      makeReq(`/api/projects/${projectBId}/tasks`, {
        userName: owner,
        authToken: rawKey,
      }),
      { params: Promise.resolve({ projectId: projectBId }) },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    // The message intentionally drops the "Exec-scoped" label when execRunId
    // is absent — this is a regular project-scoped key, not an exec session.
    expect(body.error.message).toMatch(/Project-scoped/i);
    expect(body.error.message).toMatch(/different project/i);
  });

  it('still allows the same projectId-bound key on its own project (regression)', async () => {
    const { rawKey, keyPrefix, keyHash } = await mintKey('home');
    const row = await testPrisma.apiKey.create({
      data: {
        projectId: projectAId,
        name: 'r137-home-project-key',
        keyHash,
        keyPrefix,
        permissions: ['read', 'write'],
        createdBy: owner,
      },
    });
    createdKeyIds.push(row.id);

    const res = await tasksGet(
      makeReq(`/api/projects/${projectAId}/tasks`, {
        userName: owner,
        authToken: rawKey,
      }),
      { params: Promise.resolve({ projectId: projectAId }) },
    );

    // 200 = membership + scope both pass. Critically NOT 403.
    expect(res.status).toBe(200);
  });

  it('rejects a key with execRunId but no projectId (dirty-data guard)', async () => {
    // Construct the second R-137 case: somehow an ApiKey landed in the DB
    // with execRunId set but projectId NULL. This should never happen via
    // the public mint path (issue-token always sets both), but we treat it
    // as untrusted and refuse to authorise any project access.
    const { rawKey, keyPrefix, keyHash } = await mintKey('dirty');
    const row = await testPrisma.apiKey.create({
      data: {
        projectId: null,
        name: 'r137-dirty-execrun-key',
        keyHash,
        keyPrefix,
        permissions: ['read', 'write'],
        createdBy: owner,
        execRunId: runId,
      },
    });
    createdKeyIds.push(row.id);

    const res = await tasksGet(
      makeReq(`/api/projects/${projectAId}/tasks`, {
        userName: owner,
        authToken: rawKey,
      }),
      { params: Promise.resolve({ projectId: projectAId }) },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toMatch(/missing its project binding|dirty data/i);
  });
});
