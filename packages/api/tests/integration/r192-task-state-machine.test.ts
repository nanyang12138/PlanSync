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
import { POST as runsStartPost } from '@/app/api/projects/[projectId]/tasks/[taskId]/runs/route';
import { PATCH as taskPatch } from '@/app/api/projects/[projectId]/tasks/[taskId]/route';
import { deriveTaskCompletionState, normalizePrUrl } from '@/lib/task-state-machine';
import {
  makeReq,
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
  addMember,
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

  it('does NOT cross-match commit evidence between same-slug deliverables on different plan versions (closes #1212 #1190 #1182 #1178 #1174 #1160 #1137)', async () => {
    // A project carries the deliverable `r192-deliverable-a` on v1
    // (the planVersion seeded by createActivePlan). Build a second
    // plan row with the same slug at a different version, register
    // a commit link against the v_other deliverable, then attempt
    // to satisfy the gate for a task bound to v_other → must work,
    // for a task bound to v1 → must FAIL because v1's deliverable
    // has no evidence even though a same-slug deliverable on v_other
    // does. Pre-fix, the lookup matched both rows and the commit
    // linked to v_other silently satisfied v1's gate.
    const otherVersion = planVersion + 100; // arbitrary other version
    const otherPlan = await testPrisma.plan.create({
      data: {
        projectId,
        version: otherVersion,
        status: 'superseded',
        title: 'r192 cross-version probe plan',
        goal: 'g',
        scope: 's',
        constraints: [],
        standards: [],
        deliverables: [deliverableA.slug],
        openQuestions: [],
        createdBy: owner,
      },
    });
    const otherDeliverable = await testPrisma.planDeliverable.create({
      data: {
        planId: otherPlan.id,
        slug: deliverableA.slug, // same slug, different row + plan version
        title: 'r192 cross-version probe deliverable',
        body: 'b',
        refType: 'file_glob',
        refUri: 'src/r192/other/**/*.ts',
        status: 'active',
      },
    });
    // Evidence linked to the OTHER plan version's deliverable only.
    await testPrisma.commitDeliverableLink.create({
      data: {
        projectId,
        sha: '9999cross9999cross9999cross9999cross9999',
        deliverableId: otherDeliverable.id,
        matchedBy: 'glob',
        matchedRef: 'src/r192/other/foo.ts',
      },
    });
    // The task is on planVersion (v1). With boundPlanVersion scoping
    // the gate should report deliverable_evidence MISSING — even
    // though a same-slug deliverable on v_other has a commit linked.
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/777';
    const task = await newTask({ prUrl });
    await emitMergedPrEvent(prUrl);
    const result = await deriveTaskCompletionState({
      projectId,
      task: {
        id: task.id,
        prUrl: task.prUrl,
        planDeliverableRefs: task.planDeliverableRefs,
        boundPlanVersion: planVersion,
      },
    });
    expect(result.status).toBe('awaiting_evidence');
    expect(result.missing.map((m) => m.code)).toContain('deliverable_evidence');

    // Sanity check: a task bound to the OTHER plan version DOES see
    // the evidence (proves the scoping cut the right way around,
    // not a blanket "always missing" regression).
    const altTask = await newTask({ prUrl: `${prUrl}-alt` });
    await emitMergedPrEvent(`${prUrl}-alt`);
    const altResult = await deriveTaskCompletionState({
      projectId,
      task: {
        id: altTask.id,
        prUrl: `${prUrl}-alt`,
        planDeliverableRefs: altTask.planDeliverableRefs,
        boundPlanVersion: otherVersion,
      },
    });
    // The deliverable on v_other has a commit link → no
    // deliverable_evidence in `missing`.
    expect(altResult.missing.map((m) => m.code)).not.toContain('deliverable_evidence');
  });

  it('short-circuits with gateApplied=false on a legacy task (no prUrl, no refs) even when the project has githubRepo set (closes #1197)', async () => {
    // Regression for #1197: enabling GitHub integration on a project
    // (i.e. setting `project.githubRepo`) must NOT retroactively trap
    // every old task that never had a prUrl or planDeliverableRefs.
    // The R-192 gate is per-task opt-in — a task that carries no git
    // wiring of its own falls back to legacy "always done" so the
    // owner can migrate one task at a time.
    //
    // The shared fixture project here already has `githubRepo` set
    // (see beforeAll) so this asserts the buggy interaction directly.
    const legacy = await testPrisma.task.create({
      data: {
        projectId,
        title: 'r192-legacy-pre-github',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: agentName,
        assigneeType: 'agent',
        boundPlanVersion: planVersion,
        agentConstraints: [],
        planDeliverableRefs: [],
        prUrl: null,
      },
    });
    const result = await deriveTaskCompletionState({
      projectId,
      task: { id: legacy.id, prUrl: null, planDeliverableRefs: [] },
    });
    expect(result.gateApplied).toBe(false);
    expect(result.status).toBe('done');
    expect(result.missing).toEqual([]);
  });

  it('still fires the gate when the task has refs but no prUrl (per-task opt-in is not "off when prUrl missing")', async () => {
    // Counterpart to the legacy case above: a task that opted in to
    // git wiring via planDeliverableRefs (even without a prUrl yet)
    // must still be gated, otherwise the fix would silently disable
    // the R-192 enforcement that R-192 was designed to provide. Here
    // the task has refs but no prUrl + no commit evidence + no merged
    // PR — both pr_merged and deliverable_evidence must surface as
    // missing.
    const task = await newTask({ prUrl: null, refs: [deliverableA.slug] });
    const result = await deriveTaskCompletionState({
      projectId,
      task: {
        id: task.id,
        prUrl: null,
        planDeliverableRefs: task.planDeliverableRefs,
        boundPlanVersion: planVersion,
      },
    });
    expect(result.gateApplied).toBe(true);
    expect(result.status).toBe('awaiting_evidence');
    const codes = result.missing.map((m) => m.code);
    expect(codes).toContain('pr_merged');
    expect(codes).toContain('deliverable_evidence');
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

// ---------------------------------------------------------------
// 4. R-192 recovery: awaiting_evidence is no longer a dead state
// ---------------------------------------------------------------
//
// Pre-fix, a task parked in `awaiting_evidence` was stuck:
//   - The originating run had already been finalised as `completed`,
//     so a second `action=complete` call on it 409'd ("Execution is
//     completed.").
//   - `execution_start` (POST /runs) rejected any task not in
//     `todo`/`in_progress`, so the agent couldn't open a fresh run
//     to re-supply evidence.
//   - The PATCH state machine had no out-transitions for
//     `awaiting_evidence`, so even an owner couldn't manually
//     reopen it.
//
// The fixes here cover the recovery story end-to-end:
//   (i)  POST /runs accepts `awaiting_evidence` and bumps the task
//        back to `in_progress` so a second `execution_complete` can
//        re-run the R-192 gate against fresh evidence.
//   (ii) PATCH /tasks/:id permits awaiting_evidence → done /
//        in_progress / blocked / cancelled so owners have an explicit
//        manual override path.

describe('R-192 recovery: awaiting_evidence has out-transitions (closes #1218 #1215 #1210 #1203 #1196 #1187 #1180 #1176 #1172 #1158 #1150 #1135 #1122 #1082 #1077)', () => {
  it('allows starting a new run on an awaiting_evidence task and flips it to done once evidence arrives', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/300';
    const task = await newTask({ prUrl });
    await linkCommitToDeliverable(deliverableA.id, 'ffff6666ffff6666ffff6666ffff6666ffff6666');

    // ---- Step 1: first complete parks the task in awaiting_evidence
    const runId1 = await startRun(task.id);
    const res1 = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/runs/${runId1}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'first attempt, PR not yet merged',
          filesChanged: ['src/r192/foo.ts'],
          deliverablesMet: [`${deliverableA.slug}: implemented`],
        },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id, runId: runId1 }) },
    );
    expect(res1.status).toBe(200);
    const j1 = await res1.json();
    expect(j1.data.taskStatus).toBe('awaiting_evidence');
    const parkedTask = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(parkedTask?.status).toBe('awaiting_evidence');

    // ---- Step 2: the agent supplies evidence (PR finally merges)
    await emitMergedPrEvent(prUrl);

    // ---- Step 3: start a fresh run via the public route. Pre-fix
    // this 409'd with "Cannot start execution: task is awaiting_evidence".
    const startRes = await runsStartPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/runs`, {
        method: 'POST',
        userName: agentName,
        body: { executorName: agentName, executorType: 'agent' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(startRes.status).toBe(201);
    const startJson = await startRes.json();
    const runId2: string = startJson.data.id;
    expect(runId2).toBeTruthy();
    // The task should have been bumped back to in_progress so the
    // rest of the system sees a normal task/run pair.
    const taskMidFlight = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(taskMidFlight?.status).toBe('in_progress');

    // ---- Step 4: complete the new run; R-192 now flips to done
    const res2 = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/runs/${runId2}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'second attempt, PR merged',
          filesChanged: ['src/r192/foo.ts'],
          deliverablesMet: [`${deliverableA.slug}: implemented`],
        },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id, runId: runId2 }) },
    );
    expect(res2.status).toBe(200);
    const j2 = await res2.json();
    expect(j2.data.taskStatus).toBe('done');
    expect(j2.data.missing).toEqual([]);
    const taskAfter = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(taskAfter?.status).toBe('done');
  });

  it('allows the owner to PATCH awaiting_evidence → done / in_progress / cancelled', async () => {
    const allowedTransitions: Array<'done' | 'in_progress' | 'cancelled'> = [
      'done',
      'in_progress',
      'cancelled',
    ];
    for (const next of allowedTransitions) {
      const prUrl = `https://github.com/plansync-test/r192-repo/pull/${400 + allowedTransitions.indexOf(next)}`;
      const t = await newTask({ prUrl });
      // Park directly via DB write so each iteration is independent.
      await testPrisma.task.update({
        where: { id: t.id },
        data: { status: 'awaiting_evidence' },
      });
      const res = await taskPatch(
        makeReq(`/api/projects/${projectId}/tasks/${t.id}`, {
          method: 'PATCH',
          userName: owner,
          body: { status: next },
        }),
        { params: Promise.resolve({ projectId, taskId: t.id }) },
      );
      // `done` requires either a completed run, owner role, or human
      // self-complete. The owner role covers us here.
      expect(res.status).toBe(200);
      const after = await testPrisma.task.findUnique({ where: { id: t.id } });
      expect(after?.status).toBe(next);
    }
  });
});

// ---------------------------------------------------------------
// 5. R-192 evidence-gate bypass on PATCH (closes #1342)
// ---------------------------------------------------------------
//
// Pre-fix, a developer-role member could bypass the R-192 evidence gate
// in two steps:
//
//   1. PATCH /tasks/:id { status: 'in_progress' }
//      Allowed by VALID_STATUS_TRANSITIONS (awaiting_evidence →
//      in_progress) with no permission check on the source state.
//   2. PATCH /tasks/:id { status: 'done' }
//      The route's `hasCompletedRun` proxy was satisfied by the *stale*
//      R-192-gated completed run from before the parking, so the done
//      check waved the transition through even though no new evidence
//      had landed.
//
// The fix re-evaluates `deriveTaskCompletionState` inside the done PATCH
// for non-owner callers and rejects with R192_EVIDENCE_MISSING when the
// gate would still park the task in `awaiting_evidence`. The owner
// override path documented in the recovery test above is preserved.

describe('R-192 evidence-gate bypass via PATCH (closes #1342)', () => {
  const dev = 'r192-dev-1342';

  beforeAll(async () => {
    await addMember(projectId, dev, 'developer');
  });

  async function parkInAwaitingEvidence(prUrl: string) {
    // Build the same "first complete with no merged PR" scenario the
    // recovery test uses: a task with a prUrl and deliverable evidence,
    // but the PR webhook never arrived, so R-192 parks it.
    const task = await newTask({ prUrl });
    await linkCommitToDeliverable(deliverableA.id, 'aaaabbbbccccddddeeeeffff0000111122223333');
    const runId = await startRun(task.id);
    const res = await runActionPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/runs/${runId}?action=complete`, {
        method: 'POST',
        userName: owner,
        body: {
          status: 'completed',
          outputSummary: 'first attempt, PR not merged',
          filesChanged: ['src/r192/foo.ts'],
          deliverablesMet: [`${deliverableA.slug}: implemented`],
        },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id, runId }) },
    );
    expect(res.status).toBe(200);
    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('awaiting_evidence');
    return { task, runId };
  }

  it('blocks the awaiting_evidence → in_progress → done bypass for a non-owner', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/1342';
    const { task } = await parkInAwaitingEvidence(prUrl);

    // Step 1: dev PATCH awaiting_evidence → in_progress. The state
    // machine itself allows this (only `done` carries explicit perm
    // checks today); we let it through to prove the security boundary
    // catches at step 2 even if step 1 is reachable.
    const step1 = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: dev,
        body: { status: 'in_progress' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(step1.status).toBe(200);
    const midTask = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(midTask?.status).toBe('in_progress');

    // Step 2: dev PATCH in_progress → done. Pre-fix this returned 200;
    // post-fix it must 409 with R192_EVIDENCE_MISSING because the PR
    // has not actually merged yet.
    const step2 = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: dev,
        body: { status: 'done' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(step2.status).toBe(409);
    const errJson = await step2.json();
    // Convention in this route (matches RUN_STALE_VERSION etc.): the
    // top-level `error.code` carries the AppError category
    // (STATE_CONFLICT for a 409) and `error.details.code` carries the
    // specific sub-code that callers branch on.
    expect(errJson.error.code).toBe('STATE_CONFLICT');
    expect(errJson.error.details?.code).toBe('R192_EVIDENCE_MISSING');
    expect(Array.isArray(errJson.error.details?.missing)).toBe(true);
    expect(errJson.error.details.missing.map((m: { code: string }) => m.code)).toContain(
      'pr_merged',
    );

    // The task must remain in_progress (the failed transition) so we
    // can prove the write was rejected, not partially applied.
    const finalTask = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(finalTask?.status).toBe('in_progress');
  });

  it('blocks the direct awaiting_evidence → done bypass for a non-owner', async () => {
    // The shortest form of the bypass: skip the in_progress detour and
    // PATCH straight to done. Same root cause (`hasCompletedRun` honoured
    // the stale R-192-gated run); same fix catches it.
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/1343';
    const { task } = await parkInAwaitingEvidence(prUrl);

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: dev,
        body: { status: 'done' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(409);
    const errJson = await res.json();
    expect(errJson.error.code).toBe('STATE_CONFLICT');
    expect(errJson.error.details?.code).toBe('R192_EVIDENCE_MISSING');

    const finalTask = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(finalTask?.status).toBe('awaiting_evidence');
  });

  it('still lets a non-owner reach done via PATCH once R-192 actually passes (no regression on legitimate flow)', async () => {
    // Same setup but this time the PR actually merges between park and
    // the dev's PATCH. R-192 now returns `done`, so the gate must NOT
    // block the transition — the security check is about evidence, not
    // about role.
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/1344';
    const { task } = await parkInAwaitingEvidence(prUrl);
    await emitMergedPrEvent(prUrl);

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: dev,
        body: { status: 'done' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(200);
    const finalTask = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(finalTask?.status).toBe('done');
  });

  it('preserves the owner override path even when R-192 still gates the task', async () => {
    // The owner is explicitly exempt from the R-192 re-check so the
    // documented "forward to done (owner override after evidence finally
    // lands)" exit stays usable when the owner intentionally accepts the
    // work without waiting for the webhook. This must not regress.
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/1345';
    const { task } = await parkInAwaitingEvidence(prUrl);

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: owner,
        body: { status: 'done' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(200);
    const finalTask = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(finalTask?.status).toBe('done');
  });

  it('leaves legacy tasks (no PR url, no deliverable refs) on their pre-R-192 path', async () => {
    // gateApplied=false short-circuit: a task with no git wiring must
    // still be markable done by a non-owner via the existing
    // `hasCompletedRun` proxy, otherwise the fix would silently break
    // every legacy project. We exercise the human-self-complete branch
    // here because it's the simplest non-owner path that doesn't
    // require staging an ExecutionRun.
    const legacyAssignee = 'r192-legacy-self-1342';
    await addMember(projectId, legacyAssignee, 'developer');
    const legacy = await testPrisma.task.create({
      data: {
        projectId,
        title: 'r192-1342-legacy',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: legacyAssignee,
        assigneeType: 'human',
        boundPlanVersion: planVersion,
        agentConstraints: [],
        planDeliverableRefs: [],
        prUrl: null,
      },
    });
    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${legacy.id}`, {
        method: 'PATCH',
        userName: legacyAssignee,
        body: { status: 'done' },
      }),
      { params: Promise.resolve({ projectId, taskId: legacy.id }) },
    );
    expect(res.status).toBe(200);
    const after = await testPrisma.task.findUnique({ where: { id: legacy.id } });
    expect(after?.status).toBe('done');
  });

  // closes #1381 — the R-192 recheck must judge the **post-update
  // candidate** snapshot. Pre-fix it used `task.prUrl` from the row
  // fetched at the top of PATCH, so a non-owner who attached the PR
  // URL atomically with the done flip (`{ prUrl, status: 'done' }`)
  // was rejected with R192_EVIDENCE_MISSING even though the new
  // `prUrl` would have satisfied the gate immediately after the
  // write. The fix merges `body.prUrl` over `task.prUrl` before
  // calling `deriveTaskCompletionState` so the gate sees the row
  // exactly as it will land.
  it('uses the post-update candidate prUrl in the R-192 recheck (closes #1381)', async () => {
    // Build a task that has *no* prUrl yet, so the gate would say
    // pr_merged-missing if it judged the pre-update row. The
    // deliverable evidence and the merged-PR webhook are pre-staged
    // so the only signal that matters for this test is whether the
    // recheck looks at `body.prUrl` or `task.prUrl`.
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/1381';
    await emitMergedPrEvent(prUrl);
    await linkCommitToDeliverable(deliverableA.id, '1381138113811381138113811381138113811381');

    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'r192-1381-same-request-pr-attach',
        type: 'code',
        priority: 'p1',
        // We park the task in `in_progress` so we don't trip the
        // separate `awaiting_evidence → done` owner-only guard above;
        // the bug here is purely about whose `prUrl` the recheck reads,
        // not about which source state is permitted.
        status: 'in_progress',
        assignee: dev,
        assigneeType: 'human',
        boundPlanVersion: planVersion,
        agentConstraints: [],
        planDeliverableRefs: [deliverableA.slug],
        prUrl: null,
      },
    });
    // A prior completed run is the bypass-vector that PR #1354 closes;
    // we need one on file so the route's earlier `hasCompletedRun`
    // branch lets the request reach the R-192 recheck (otherwise it
    // would short-circuit on the "no completed run" 409 above).
    await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        status: 'completed',
        executorType: 'agent',
        executorName: agentName,
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(),
        endedAt: new Date(),
      },
    });

    // Pre-fix: rejected with 409 R192_EVIDENCE_MISSING because the
    // recheck saw `task.prUrl === null` and reported `pr_merged`
    // missing. Post-fix: the recheck merges `body.prUrl` over
    // `task.prUrl`, sees the merged PR, and lets the transition land.
    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: dev,
        body: { prUrl, status: 'done' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(200);
    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('done');
    // The prUrl write must have actually landed — proves we used the
    // merged candidate, not just a transient in-memory override.
    expect(after?.prUrl).toBe(prUrl);
  });

  // Counterpart sanity check: when the candidate prUrl is also
  // missing (e.g. the caller submits `{ status: 'done' }` only, or
  // `{ prUrl: null, status: 'done' }`), the recheck must still
  // reject. This guards against the candidate-merge accidentally
  // turning a legitimate evidence-gap into a silent pass.
  it('still rejects when the post-update candidate prUrl is also unmerged (closes #1381 negative)', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/1381-neg';
    const { task } = await parkInAwaitingEvidence(prUrl);
    // The PR URL is set on the row but never merged via webhook,
    // so the gate must still report pr_merged-missing. The body
    // does not touch `prUrl`, so the candidate equals `task.prUrl`.
    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: dev,
        body: { status: 'done' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(409);
    const errJson = await res.json();
    expect(errJson.error.details?.code).toBe('R192_EVIDENCE_MISSING');
    expect(errJson.error.details.missing.map((m: { code: string }) => m.code)).toContain(
      'pr_merged',
    );
  });
});
