/**
 * R-192: task status is derived from git + verification rule signals
 * rather than flipped unilaterally by the agent's `action=complete`
 * call.
 *
 * Acceptance from REMEDIATION_PLAN.md (R-192):
 *   "vitest：PR 未合并 → status='awaiting_evidence'，response.missing
 *    包含 `pr_merged`；全部命中 → status='done'"
 *
 * The state machine lives at `packages/api/src/lib/task-state-machine.ts`
 * and is exercised from the existing runs route at
 * `packages/api/src/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route.ts`.
 *
 * The tests cover three slices:
 *
 *   1. Pure unit: `deriveTaskCompletionState` returns
 *      `awaiting_evidence` + missing=['pr_merged'] when no merged PR
 *      event has landed.
 *   2. Pure unit: returns `done` once a matching merged PR event is in
 *      the outbox and at least one commit_deliverable_links row covers
 *      every bound deliverable.
 *   3. End-to-end through the runs POST route: a real `action=complete`
 *      call lands the task in `awaiting_evidence`, the response body
 *      carries `data.taskStatus = 'awaiting_evidence'` and
 *      `data.missing[].code === 'pr_merged'`, and the run itself still
 *      finalises so the agent's work isn't lost.
 *
 * Backwards-compat slice: a task with no `prUrl` AND a project with no
 * `githubRepo` short-circuits the gate so legacy projects keep flipping
 * straight to `done` (this is the safety hatch documented in the helper
 * — see "Backwards compatibility" in `task-state-machine.ts`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Stub the AI verifier so it never fires a 422 from the AI path — every
// failure in these tests must come from the R-192 gate to keep the
// assertions unambiguous. We mirror the mock shape used by r181/r143.
type MockState = { nextResult: string | null; modelName: string | null };
const mockState: MockState = { nextResult: null, modelName: null };
vi.mock('@/lib/ai/client', () => ({
  aiClient: {
    get isAvailable() {
      return mockState.modelName !== null;
    },
    get providerName() {
      return mockState.modelName ? 'mock' : 'none';
    },
    get modelName() {
      return mockState.modelName;
    },
    complete: vi.fn(async () => mockState.nextResult),
  },
}));

import { POST as runActionPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/[runId]/route';
import { deriveTaskCompletionState, normalizePrUrl } from '@/lib/task-state-machine';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';

const owner = 'r192-owner';
const agentName = 'r192-agent';
const repoSlug = 'plansync-test/r192-repo';

let projectId: string;
let planId: string;
let planVersion: number;
let deliverableA: { id: string; slug: string };

beforeAll(async () => {
  ({ projectId } = await createTestProject(owner));
  // R-192 opt-in: the project must have a githubRepo for the PR-merged
  // path of the gate to even fire. Without it the gate stays silent
  // (legacy "always done") which is fine for the backwards-compat
  // slice below but would make the awaiting_evidence assertions
  // trivially vacuous if we forgot to set it on the project under test.
  await testPrisma.project.update({
    where: { id: projectId },
    data: { githubRepo: repoSlug },
  });
  const { planId: pid, version } = await createActivePlan(projectId, owner);
  planId = pid;
  planVersion = version;

  await testPrisma.projectMember.create({
    data: { projectId, name: agentName, role: 'developer', type: 'agent' },
  });

  const deliverable = await testPrisma.planDeliverable.create({
    data: {
      planId,
      slug: 'r192-feature',
      title: 'R-192 feature',
      body: 'the feature under test',
      refType: 'file_glob',
      refUri: 'src/r192/**/*.ts',
      status: 'active',
    },
  });
  deliverableA = { id: deliverable.id, slug: deliverable.slug };
});

afterAll(async () => {
  await cleanupProject(projectId);
});

beforeEach(async () => {
  await testPrisma.executionRun.deleteMany({ where: { task: { projectId } } });
  await testPrisma.commitDeliverableLink.deleteMany({ where: { projectId } });
  await testPrisma.domainEvent.deleteMany({ where: { projectId } });
  mockState.nextResult = null;
  mockState.modelName = null;
});

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

async function newTask(opts: { prUrl?: string | null; refs?: string[] } = {}) {
  return testPrisma.task.create({
    data: {
      projectId,
      title: `r192-task-${Math.random().toString(36).slice(2, 8)}`,
      type: 'code',
      priority: 'p1',
      status: 'in_progress',
      assignee: agentName,
      assigneeType: 'agent',
      boundPlanVersion: planVersion,
      agentConstraints: [],
      planDeliverableRefs: opts.refs ?? [deliverableA.slug],
      prUrl: opts.prUrl ?? null,
    },
  });
}

async function startRun(taskId: string) {
  const run = await testPrisma.executionRun.create({
    data: {
      taskId,
      status: 'running',
      executorType: 'agent',
      executorName: agentName,
      boundPlanVersion: planVersion,
      taskPackSnapshot: {},
      startedAt: new Date(),
    },
  });
  return run.id;
}

async function emitMergedPrEvent(prUrl: string) {
  // Match the shape that R-190 writes when GitHub delivers a merged
  // pull_request webhook. The outer envelope is the `domainEventPayloadSchema`
  // discriminated union (R-160); the inner `data.payload` is the raw
  // GitHub event.
  await testPrisma.domainEvent.create({
    data: {
      eventType: 'github_pull_request',
      projectId,
      payload: {
        type: 'github_pull_request',
        projectId,
        data: {
          deliveryId: `delivery-${Math.random().toString(36).slice(2)}`,
          repository: repoSlug,
          payload: {
            action: 'closed',
            pull_request: {
              html_url: prUrl,
              merged: true,
            },
          },
        },
      },
    },
  });
}

async function linkCommitToDeliverable(deliverableId: string, sha: string) {
  await testPrisma.commitDeliverableLink.create({
    data: {
      projectId,
      sha,
      deliverableId,
      matchedBy: 'glob',
      matchedRef: 'src/r192/foo.ts',
    },
  });
}

// ---------------------------------------------------------------
// 1. Pure unit — gate returns awaiting_evidence with missing=pr_merged
// ---------------------------------------------------------------

describe('R-192: deriveTaskCompletionState', () => {
  it('returns awaiting_evidence + missing=["pr_merged"] when the PR has not been observed as merged', async () => {
    const task = await newTask({ prUrl: 'https://github.com/plansync-test/r192-repo/pull/1' });
    // No merged PR event in the outbox; deliverable evidence exists so
    // the only missing signal must be pr_merged. This is the exact
    // spec acceptance ("PR 未合并 → missing 包含 pr_merged").
    await linkCommitToDeliverable(deliverableA.id, 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    const result = await deriveTaskCompletionState({
      projectId,
      task: { id: task.id, prUrl: task.prUrl, planDeliverableRefs: task.planDeliverableRefs },
    });
    expect(result.gateApplied).toBe(true);
    expect(result.status).toBe('awaiting_evidence');
    const codes = result.missing.map((m) => m.code);
    expect(codes).toContain('pr_merged');
    expect(codes).not.toContain('deliverable_evidence');
    expect(codes).not.toContain('drift_open');
  });

  it('returns done once the merged PR event + commit evidence both exist', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/42';
    const task = await newTask({ prUrl });
    await linkCommitToDeliverable(deliverableA.id, 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222');
    await emitMergedPrEvent(prUrl);

    const result = await deriveTaskCompletionState({
      projectId,
      task: { id: task.id, prUrl: task.prUrl, planDeliverableRefs: task.planDeliverableRefs },
    });
    expect(result.gateApplied).toBe(true);
    expect(result.status).toBe('done');
    expect(result.missing).toEqual([]);
  });

  it('flags deliverable_evidence missing when bound refs have no commit link', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/2';
    const task = await newTask({ prUrl });
    await emitMergedPrEvent(prUrl);
    // No CommitDeliverableLink rows — deliverable_evidence must fail.

    const result = await deriveTaskCompletionState({
      projectId,
      task: { id: task.id, prUrl: task.prUrl, planDeliverableRefs: task.planDeliverableRefs },
    });
    expect(result.status).toBe('awaiting_evidence');
    const codes = result.missing.map((m) => m.code);
    expect(codes).toContain('deliverable_evidence');
    expect(codes).not.toContain('pr_merged');
  });

  it('flags drift_open when an open drift alert is present', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/3';
    const task = await newTask({ prUrl });
    await emitMergedPrEvent(prUrl);
    await linkCommitToDeliverable(deliverableA.id, 'cccc3333cccc3333cccc3333cccc3333cccc3333');
    await testPrisma.driftAlert.create({
      data: {
        projectId,
        taskId: task.id,
        currentPlanVersion: planVersion + 1,
        taskBoundVersion: planVersion,
        reason: 'plan changed',
        severity: 'medium',
        status: 'open',
      },
    });

    const result = await deriveTaskCompletionState({
      projectId,
      task: { id: task.id, prUrl: task.prUrl, planDeliverableRefs: task.planDeliverableRefs },
    });
    expect(result.status).toBe('awaiting_evidence');
    expect(result.missing.map((m) => m.code)).toContain('drift_open');
  });

  it('short-circuits with gateApplied=false when neither task nor project carries git wiring', async () => {
    // Create a brand-new project with no githubRepo set, then assert
    // the gate stays silent so legacy flows keep their always-done
    // behaviour. The helper's behaviour here is the safety hatch
    // documented in the implementation.
    const { projectId: bareProjectId } = await createTestProject('r192-bare-owner');
    try {
      const { version: bareVersion } = await createActivePlan(bareProjectId, 'r192-bare-owner');
      const t = await testPrisma.task.create({
        data: {
          projectId: bareProjectId,
          title: 't-bare',
          type: 'code',
          priority: 'p1',
          status: 'in_progress',
          boundPlanVersion: bareVersion,
          agentConstraints: [],
          planDeliverableRefs: [],
          prUrl: null,
        },
      });
      const result = await deriveTaskCompletionState({
        projectId: bareProjectId,
        task: { id: t.id, prUrl: null, planDeliverableRefs: [] },
      });
      expect(result.gateApplied).toBe(false);
      expect(result.status).toBe('done');
      expect(result.missing).toEqual([]);
    } finally {
      await cleanupProject(bareProjectId);
    }
  });
});

// ---------------------------------------------------------------
// 2. normalizePrUrl — pure helper
// ---------------------------------------------------------------

describe('R-192: normalizePrUrl', () => {
  it('strips trailing /files and /commits suffixes that GitHub appends in UI links', () => {
    expect(normalizePrUrl('https://github.com/o/r/pull/7/files')).toBe(
      'https://github.com/o/r/pull/7',
    );
    expect(normalizePrUrl('https://github.com/o/r/pull/7/commits/')).toBe(
      'https://github.com/o/r/pull/7',
    );
  });
  it('strips fragments and query strings (issue comment deep links)', () => {
    expect(normalizePrUrl('https://github.com/o/r/pull/7#issuecomment-123')).toBe(
      'https://github.com/o/r/pull/7',
    );
    expect(normalizePrUrl('https://github.com/o/r/pull/7?utm_source=email')).toBe(
      'https://github.com/o/r/pull/7',
    );
  });
});

// ---------------------------------------------------------------
// 3. End-to-end through the runs POST route
// ---------------------------------------------------------------

describe('R-192: runs POST applies the awaiting_evidence gate', () => {
  it('lands the task in awaiting_evidence + echoes missing=pr_merged when the PR has not merged', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/100';
    const task = await newTask({ prUrl });
    // Deliverable evidence is present so only pr_merged is missing —
    // this matches the spec's "PR 未合并" case literally.
    await linkCommitToDeliverable(deliverableA.id, 'dddd4444dddd4444dddd4444dddd4444dddd4444');

    const runId = await startRun(task.id);
    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/runs/${runId}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'agent claims done',
          filesChanged: ['src/r192/foo.ts'],
          deliverablesMet: [`${deliverableA.slug}: implemented`],
        },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id, runId }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.taskStatus).toBe('awaiting_evidence');
    const codes = (json.data.missing as Array<{ code: string }>).map((m) => m.code);
    expect(codes).toContain('pr_merged');

    const taskAfter = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(taskAfter?.status).toBe('awaiting_evidence');

    // The run itself must still finalize — the agent's work is captured
    // so a follow-up complete attempt can re-derive the state once the
    // PR finally merges, without losing the output summary.
    const runAfter = await testPrisma.executionRun.findUnique({ where: { id: runId } });
    expect(runAfter?.status).toBe('completed');
    expect(runAfter?.endedAt).not.toBeNull();
  });

  it('flips the task to done when PR merged + commit evidence + no drift all line up', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/200';
    const task = await newTask({ prUrl });
    await linkCommitToDeliverable(deliverableA.id, 'eeee5555eeee5555eeee5555eeee5555eeee5555');
    await emitMergedPrEvent(prUrl);

    const runId = await startRun(task.id);
    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/runs/${runId}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'agent claims done with evidence',
          filesChanged: ['src/r192/foo.ts'],
          deliverablesMet: [`${deliverableA.slug}: implemented`],
        },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id, runId }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.taskStatus).toBe('done');
    expect(json.data.missing).toEqual([]);

    const taskAfter = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(taskAfter?.status).toBe('done');
  });
});
