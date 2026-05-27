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
  spyOnProductionPrisma,
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

async function emitMergedPrEvent(
  prUrl: string,
  opts: { mergeCommitSha?: string; headSha?: string; baseRef?: string } = {},
) {
  // Match the shape that R-190 writes when GitHub delivers a merged
  // pull_request webhook. The outer envelope is the `domainEventPayloadSchema`
  // discriminated union (R-160); the inner `data.payload` is the raw
  // GitHub event. We always populate `merge_commit_sha` so the
  // task-state-machine's deliverable_evidence check (closes #1189)
  // can bind commit links to *this PR* — without it the gate falls
  // back to "no SHAs" and every deliverable ref is reported missing,
  // which is fail-closed but trivially flunks every assertion below.
  // `base.ref` is required so the push-expansion lookup can scope to
  // the PR's base branch and reject pushes on other refs that happen
  // to share the merge SHA (closes #1420).
  const mergeCommitSha = opts.mergeCommitSha ?? defaultMergeShaFor(prUrl);
  const headSha = opts.headSha ?? defaultHeadShaFor(prUrl);
  const baseRef = opts.baseRef ?? 'main';
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
              merge_commit_sha: mergeCommitSha,
              head: { sha: headSha },
              base: { ref: baseRef },
            },
          },
        },
      },
    },
  });
  return { mergeCommitSha, headSha, baseRef };
}

/**
 * Deterministic merge-commit SHA derived from the PR URL so each test
 * case can predict which SHA `linkCommitToDeliverable` must use. Real
 * SHAs are 40-char lowercase hex; we pad to that length so the value
 * round-trips through the GitHub-shape JSON path without surprise.
 */
function defaultMergeShaFor(prUrl: string): string {
  return ('m' + Buffer.from(prUrl).toString('hex')).slice(0, 40).padEnd(40, '0');
}
function defaultHeadShaFor(prUrl: string): string {
  return ('h' + Buffer.from(prUrl).toString('hex')).slice(0, 40).padEnd(40, '0');
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
    // No merged PR event in the outbox; spec acceptance requires
    // `pr_merged` ∈ missing. We do NOT also assert
    // `not.toContain('deliverable_evidence')` here: post-#1189, the
    // deliverable-evidence check binds commits to the PR's merge
    // SHAs, so when the PR has not merged there are no SHAs to match
    // against and `deliverable_evidence` legitimately also surfaces
    // as missing. The two checks are intentionally coupled — without
    // a merged PR we cannot say which commits are "this task's", so
    // we fail closed rather than accept any historical commit as
    // evidence.
    await linkCommitToDeliverable(deliverableA.id, 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    const result = await deriveTaskCompletionState({
      projectId,
      task: { id: task.id, prUrl: task.prUrl, planDeliverableRefs: task.planDeliverableRefs },
    });
    expect(result.gateApplied).toBe(true);
    expect(result.status).toBe('awaiting_evidence');
    const codes = result.missing.map((m) => m.code);
    expect(codes).toContain('pr_merged');
    expect(codes).not.toContain('drift_open');
  });

  it('returns done once the merged PR event + commit evidence both exist', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/42';
    const task = await newTask({ prUrl });
    // The linked SHA must match a SHA attributable to the PR
    // (post-#1189). Use the merge_commit_sha that emitMergedPrEvent
    // will write so the deliverable-evidence check sees a matching
    // row.
    const mergeCommitSha = defaultMergeShaFor(prUrl);
    await linkCommitToDeliverable(deliverableA.id, mergeCommitSha);
    await emitMergedPrEvent(prUrl, { mergeCommitSha });

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

  it('rejects unrelated commit evidence that touches the deliverable but is not part of this PR (closes #1189)', async () => {
    // Pre-fix: deliverable_evidence accepted ANY commit linked to the
    // deliverable in the project, so a stray historical commit (e.g.
    // an earlier PR that incidentally touched a file matching the
    // deliverable's `file_glob`) silently satisfied the gate for a
    // brand-new task. The fix binds evidence to the SHAs the PR's
    // merge webhook + the matching push event surfaced.
    //
    // Setup: PR is merged. A commit IS linked to the deliverable, but
    // its SHA does NOT match the PR's merge_commit_sha or any push
    // commit attributable to the PR (i.e. it's a historical/unrelated
    // commit). The gate must report deliverable_evidence missing.
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/1189';
    const task = await newTask({ prUrl });
    await emitMergedPrEvent(prUrl);
    // Stray commit on a different SHA — the kind of commit that
    // pre-fix would let an unrelated task pass the gate.
    await linkCommitToDeliverable(deliverableA.id, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

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
    const codes = result.missing.map((m) => m.code);
    expect(codes).toContain('deliverable_evidence');
    expect(codes).not.toContain('pr_merged');
  });

  it('accepts evidence from a push event whose head_commit matches the PR merge_commit_sha (closes #1189)', async () => {
    // Real-world: GitHub fires a `push` event to the base branch when
    // a PR is merged. Its `head_commit.id` equals the PR's
    // `merge_commit_sha`. The push payload's `commits[]` contains the
    // PR's constituent commits — the linker then writes
    // CommitDeliverableLink rows for those constituent SHAs (not for
    // the merge commit itself, which often has zero file changes for
    // a "merge commit"-style merge). The gate must accept those
    // constituent commits as evidence.
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/1189-push';
    const task = await newTask({ prUrl });
    const mergeCommitSha = defaultMergeShaFor(prUrl);
    const constituentSha = 'cafefeed' + 'cafefeed'.repeat(4); // 40-char hex
    // Emit the merged PR event AND the matching push event whose
    // head_commit.id is the merge_commit_sha. R-191's linker would
    // normally process both, but we go direct to the link table here
    // so the test stays focused on the state-machine query.
    await emitMergedPrEvent(prUrl, { mergeCommitSha });
    await testPrisma.domainEvent.create({
      data: {
        eventType: 'github_push',
        projectId,
        payload: {
          type: 'github_push',
          projectId,
          data: {
            deliveryId: `delivery-${Math.random().toString(36).slice(2)}`,
            repository: repoSlug,
            payload: {
              ref: 'refs/heads/main',
              head_commit: { id: mergeCommitSha },
              commits: [{ id: constituentSha, message: 'feat: actual change' }],
            },
          },
        },
      },
    });
    // Linker output: the constituent commit (NOT the merge commit)
    // is what carries the file_glob match.
    await linkCommitToDeliverable(deliverableA.id, constituentSha);

    const result = await deriveTaskCompletionState({
      projectId,
      task: {
        id: task.id,
        prUrl: task.prUrl,
        planDeliverableRefs: task.planDeliverableRefs,
        boundPlanVersion: planVersion,
      },
    });
    expect(result.status).toBe('done');
    expect(result.missing).toEqual([]);
  });

  it('rejects push-event commits whose ref does not match the PR base branch even when head_commit.id equals merge_commit_sha (closes #1420)', async () => {
    // Pre-fix: the push-expansion lookup matched on `head_commit.id =
    // mergeSha` alone. A push to ANY ref (a feature branch the
    // developer first pushed the merge commit onto, a cherry-pick that
    // re-landed the same SHA on another branch, a tag push, etc.)
    // whose head commit happened to share the merge SHA would inject
    // its `commits[]` into `allowedShas`. A commit in that stray push
    // that was linked to the deliverable would then silently satisfy
    // the deliverable_evidence gate for an unrelated task — the exact
    // attribution defect #1189 / PR #1394 set out to close.
    //
    // Setup: PR is merged to `main`. A second push event exists with
    // the same `head_commit.id` (the merge SHA) but targets
    // `refs/heads/feature-branch`. Its `commits[]` carries a stray
    // commit that IS linked to the deliverable. The gate must
    // surface deliverable_evidence as missing because the ref filter
    // excludes that push entirely.
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/1420';
    const task = await newTask({ prUrl });
    const mergeCommitSha = defaultMergeShaFor(prUrl);
    // 40-char hex, distinct from any PR-attributable SHA.
    const strayCommitSha = 'feedbeef'.repeat(5);
    await emitMergedPrEvent(prUrl, { mergeCommitSha, baseRef: 'main' });
    await testPrisma.domainEvent.create({
      data: {
        eventType: 'github_push',
        projectId,
        payload: {
          type: 'github_push',
          projectId,
          data: {
            deliveryId: `delivery-${Math.random().toString(36).slice(2)}`,
            repository: repoSlug,
            payload: {
              ref: 'refs/heads/feature-branch',
              head_commit: { id: mergeCommitSha },
              commits: [{ id: strayCommitSha, message: 'stray commit on unrelated ref' }],
            },
          },
        },
      },
    });
    // Link the stray commit to the deliverable. Pre-fix this would
    // satisfy the gate via the polluted allowedShas; post-fix the
    // ref filter rejects the stray push so the link is invisible.
    await linkCommitToDeliverable(deliverableA.id, strayCommitSha);

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
    const codes = result.missing.map((m) => m.code);
    expect(codes).toContain('deliverable_evidence');
    expect(codes).not.toContain('pr_merged');
  });

  it('flags drift_open when an open drift alert is present', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/3';
    const task = await newTask({ prUrl });
    const mergeCommitSha = defaultMergeShaFor(prUrl);
    await emitMergedPrEvent(prUrl, { mergeCommitSha });
    // SHA must match the PR's merge commit so deliverable_evidence is
    // not in the missing list — keeps drift_open the only signal in
    // the assertion below (post-#1189).
    await linkCommitToDeliverable(deliverableA.id, mergeCommitSha);
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
    // The task is on planVersion (v1). With boundPlanVersion scoping
    // the gate should report deliverable_evidence MISSING — even
    // though a same-slug deliverable on v_other has a commit linked.
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/777';
    const task = await newTask({ prUrl });
    await emitMergedPrEvent(prUrl);
    // Evidence linked to the OTHER plan version's deliverable only.
    // We attribute it to the *alt* PR (below) so post-#1189 the
    // alt-task assertion still finds the evidence; v1 task fails on
    // the cross-version filter regardless of which SHA the link uses
    // because v1's deliverable has no link rows at all.
    const altPrUrl = `${prUrl}-alt`;
    const altMergeSha = defaultMergeShaFor(altPrUrl);
    await testPrisma.commitDeliverableLink.create({
      data: {
        projectId,
        sha: altMergeSha,
        deliverableId: otherDeliverable.id,
        matchedBy: 'glob',
        matchedRef: 'src/r192/other/foo.ts',
      },
    });
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
    const altTask = await newTask({ prUrl: altPrUrl });
    await emitMergedPrEvent(altPrUrl, { mergeCommitSha: altMergeSha });
    const altResult = await deriveTaskCompletionState({
      projectId,
      task: {
        id: altTask.id,
        prUrl: altPrUrl,
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

  it('blocks auto-done with drift_open even when the project has no githubRepo (closes #1422 — short-circuit must not bypass drift)', async () => {
    // Regression for #1422 / PR #1353 review finding: the
    // project-level `githubRepo` short-circuit returned status='done'
    // BEFORE the helper's defense-in-depth drift check ran, so a
    // task with an open drift alert in a non-GitHub-integrated
    // project would silently flip to `done`. The drift_open guard
    // must run first.
    const { projectId: bareProjectId } = await createTestProject('r1422-bare-owner');
    try {
      const { version: bareVersion } = await createActivePlan(bareProjectId, 'r1422-bare-owner');
      const t = await testPrisma.task.create({
        data: {
          projectId: bareProjectId,
          title: 't-drift-no-github',
          type: 'code',
          priority: 'p1',
          status: 'in_progress',
          boundPlanVersion: bareVersion,
          agentConstraints: [],
          planDeliverableRefs: [],
          prUrl: null,
        },
      });
      await testPrisma.driftAlert.create({
        data: {
          projectId: bareProjectId,
          taskId: t.id,
          currentPlanVersion: bareVersion + 1,
          taskBoundVersion: bareVersion,
          reason: 'plan changed under a drifted task',
          severity: 'high',
          status: 'open',
        },
      });
      const result = await deriveTaskCompletionState({
        projectId: bareProjectId,
        task: { id: t.id, prUrl: null, planDeliverableRefs: [] },
      });
      // Pre-fix this asserted (status='done', gateApplied=false).
      // The defense-in-depth check must now block the auto-done.
      expect(result.status).toBe('awaiting_evidence');
      expect(result.gateApplied).toBe(true);
      expect(result.missing.map((m) => m.code)).toEqual(['drift_open']);
    } finally {
      await cleanupProject(bareProjectId);
    }
  });

  it('blocks auto-done with drift_open on a legacy task (no prUrl, no refs) even when the project has githubRepo (closes #1422 — per-task short-circuit must not bypass drift)', async () => {
    // Sibling regression for the per-task opt-in short-circuit: in
    // a GitHub-integrated project, a legacy task with no `prUrl`
    // and no `planDeliverableRefs` previously short-circuited to
    // `done` (gateApplied=false) before the drift check ran. Same
    // defense-in-depth concern as the project-level branch above.
    const legacy = await testPrisma.task.create({
      data: {
        projectId,
        title: 'r1422-legacy-drift',
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
    await testPrisma.driftAlert.create({
      data: {
        projectId,
        taskId: legacy.id,
        currentPlanVersion: planVersion + 1,
        taskBoundVersion: planVersion,
        reason: 'plan changed under a legacy task',
        severity: 'medium',
        status: 'open',
      },
    });
    const result = await deriveTaskCompletionState({
      projectId,
      task: { id: legacy.id, prUrl: null, planDeliverableRefs: [] },
    });
    expect(result.status).toBe('awaiting_evidence');
    expect(result.gateApplied).toBe(true);
    expect(result.missing.map((m) => m.code)).toEqual(['drift_open']);
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

  it('short-circuits with gateApplied=false when the project has no githubRepo, even if the task carries planDeliverableRefs (closes #1331)', async () => {
    // Regression for #1331: plan authors routinely populate
    // `planDeliverableRefs` on tasks for scope/coverage tracking,
    // independent of any GitHub wiring. If the project has not
    // opted into GitHub integration (`project.githubRepo` is null)
    // the webhook + commit-linker plumbing isn't running at all, so
    // neither `pr_merged` nor `deliverable_evidence` can ever be
    // satisfied — firing the gate would lock the task in
    // `awaiting_evidence` with no recovery path. The gate must stay
    // silent.
    const { projectId: bareProjectId } = await createTestProject('r1331-bare-owner');
    try {
      const { planId: barePlanId, version: bareVersion } = await createActivePlan(
        bareProjectId,
        'r1331-bare-owner',
      );
      const bareDeliverable = await testPrisma.planDeliverable.create({
        data: {
          planId: barePlanId,
          slug: 'r1331-feature',
          title: 'R-1331 feature',
          body: 'no-github-integration scope item',
          refType: 'file_glob',
          refUri: 'src/r1331/**/*.ts',
          status: 'active',
        },
      });
      const t = await testPrisma.task.create({
        data: {
          projectId: bareProjectId,
          title: 't-refs-no-github',
          type: 'code',
          priority: 'p1',
          status: 'in_progress',
          boundPlanVersion: bareVersion,
          agentConstraints: [],
          // Task IS bound to a deliverable via the plan, but the
          // project has no githubRepo — the gate must NOT fire.
          planDeliverableRefs: [bareDeliverable.slug],
          prUrl: null,
        },
      });
      const result = await deriveTaskCompletionState({
        projectId: bareProjectId,
        task: {
          id: t.id,
          prUrl: null,
          planDeliverableRefs: [bareDeliverable.slug],
          boundPlanVersion: bareVersion,
        },
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
    const mergeCommitSha = defaultMergeShaFor(prUrl);
    await linkCommitToDeliverable(deliverableA.id, mergeCommitSha);
    await emitMergedPrEvent(prUrl, { mergeCommitSha });

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
    const mergeCommitSha = defaultMergeShaFor(prUrl);
    await linkCommitToDeliverable(deliverableA.id, mergeCommitSha);

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
    await emitMergedPrEvent(prUrl, { mergeCommitSha });

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
// 5. R-192 evidence-gate bypass guard
//    (closes #1227 direct-PATCH bypass + #1306 POST-/runs bypass)
// ---------------------------------------------------------------
//
// A task parked in `awaiting_evidence` *always* has a completed
// ExecutionRun on file — that's how it got parked: the run finalised
// and R-192 explicitly judged the evidence insufficient. Two distinct
// attack shapes use that completed run to flip the task to `done`
// while skipping the R-192 gate:
//
//   (A) #1227 — Direct PATCH:
//       Non-owner PATCHes `status: 'done'` while the task is still
//       `awaiting_evidence`. The pre-fix `hasCompletedRun` shortcut
//       always matches (parked task ⇒ completed run exists) and the
//       gate is bypassed.
//
//   (B) #1306 — POST /runs lift then PATCH:
//       1. Non-owner calls POST /runs on the parked task. The runs
//          route legitimately lifts task → `in_progress` so a new
//          run can re-supply evidence (R-192 recovery path).
//       2. While the new run is `running` (or later `stale`), the old
//          completed run is still on file. Non-owner PATCHes
//          `status: 'done'` from `in_progress`. Without the latest-run
//          anchoring, `hasCompletedRun` still matches the OLD run and
//          R-192 is bypassed the same way as (A), just one extra hop.
//
// Fix: (A) is closed by an explicit awaiting_evidence-source guard;
// (B) is closed by anchoring `hasCompletedRun` on the *latest* run
// for the task rather than "any completed run anywhere in history".

describe('R-192: awaiting_evidence → done PATCH is owner-only (closes #1227 #1306)', () => {
  const developerName = 'r192-dev-bypasser';

  beforeAll(async () => {
    await testPrisma.projectMember.upsert({
      where: { projectId_name: { projectId, name: developerName } },
      update: { role: 'developer', type: 'human' },
      create: { projectId, name: developerName, role: 'developer', type: 'human' },
    });
  });

  // ---- (A) direct-PATCH attack — closes #1227 -------------------

  it('rejects a non-owner developer PATCHing awaiting_evidence → done even when a completed run exists', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/500';
    const task = await newTask({ prUrl });
    await testPrisma.task.update({
      where: { id: task.id },
      data: { status: 'awaiting_evidence' },
    });
    await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        status: 'completed',
        executorType: 'agent',
        executorName: agentName,
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(Date.now() - 60_000),
        endedAt: new Date(),
      },
    });

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: developerName,
        body: { status: 'done' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(JSON.stringify(json)).toMatch(/owner/i);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('awaiting_evidence');
  });

  it('rejects a human assignee self-completing their own awaiting_evidence task', async () => {
    const humanAssignee = 'r192-human-self';
    await testPrisma.projectMember.upsert({
      where: { projectId_name: { projectId, name: humanAssignee } },
      update: { role: 'developer', type: 'human' },
      create: { projectId, name: humanAssignee, role: 'developer', type: 'human' },
    });
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/501';
    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'r192-human-task',
        type: 'code',
        priority: 'p1',
        status: 'awaiting_evidence',
        assignee: humanAssignee,
        assigneeType: 'human',
        boundPlanVersion: planVersion,
        agentConstraints: [],
        planDeliverableRefs: [deliverableA.slug],
        prUrl,
      },
    });
    await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        status: 'completed',
        executorType: 'human',
        executorName: humanAssignee,
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(Date.now() - 60_000),
        endedAt: new Date(),
      },
    });

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: humanAssignee,
        body: { status: 'done' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(403);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('awaiting_evidence');
  });

  // ---- (B) POST-/runs lift attack — closes #1306 ----------------

  it('rejects a non-owner developer PATCHing done after lifting awaiting_evidence → in_progress via POST /runs (closes #1306)', async () => {
    // Reproduce the exact bypass shape:
    //   1. Task parked in awaiting_evidence with the old completed
    //      run on file (R-192 rejected its evidence).
    //   2. Non-owner POSTs /runs to lift the task back to in_progress.
    //   3. Non-owner PATCHes `status: 'done'` — pre-fix the OLD
    //      completed run still satisfies hasCompletedRun and the
    //      transition is silently allowed despite R-192 still failing.
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/600';
    const task = await newTask({ prUrl });
    await testPrisma.task.update({
      where: { id: task.id },
      data: { status: 'awaiting_evidence' },
    });
    await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        status: 'completed',
        executorType: 'agent',
        executorName: agentName,
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(Date.now() - 120_000),
        endedAt: new Date(Date.now() - 60_000),
      },
    });

    // Step 2 — non-owner lifts the parked task via the real route.
    const startRes = await runsStartPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/runs`, {
        method: 'POST',
        userName: agentName,
        body: { executorName: agentName, executorType: 'agent' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(startRes.status).toBe(201);
    const lifted = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(lifted?.status).toBe('in_progress');

    // Step 3 — non-owner attempts the PATCH→done bypass. The task
    // is agent-typed, so the rejection surfaces as STATE_CONFLICT
    // (409) with the agent-specific message; for human-typed tasks
    // the same branch would surface as 403 FORBIDDEN. Either way
    // the transition must NOT land.
    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: developerName,
        body: { status: 'done' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(JSON.stringify(json)).toMatch(/completed execution run/i);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('in_progress');
  });

  it('rejects the same PATCH→done bypass after the lifted run goes stale (latest run not completed → no shortcut)', async () => {
    // Variant of the #1306 attack: the new run created by POST /runs
    // goes stale instead of staying running. The task stays in
    // in_progress, the old completed run is still on file, and the
    // latest run is now `stale`. The fix must still block the bypass
    // because the latest run is not `completed`.
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/601';
    const task = await newTask({ prUrl });
    await testPrisma.task.update({
      where: { id: task.id },
      data: { status: 'awaiting_evidence' },
    });
    await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        status: 'completed',
        executorType: 'agent',
        executorName: agentName,
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(Date.now() - 180_000),
        endedAt: new Date(Date.now() - 120_000),
      },
    });
    const startRes = await runsStartPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/runs`, {
        method: 'POST',
        userName: agentName,
        body: { executorName: agentName, executorType: 'agent' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(startRes.status).toBe(201);
    const newRunId: string = (await startRes.json()).data.id;

    // Simulate the heartbeat scanner flipping the new run to stale.
    // The task stays in `in_progress` (per R-057 in heartbeat-scanner).
    await testPrisma.executionRun.update({
      where: { id: newRunId },
      data: { status: 'stale', endedAt: new Date() },
    });

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: developerName,
        body: { status: 'done' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    // Agent-typed task → STATE_CONFLICT (409). Different from the
    // direct-PATCH guard's 403 but equally blocking: the task does
    // not advance to `done`.
    expect(res.status).toBe(409);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('in_progress');
  });

  // ---- regression guard — normal flow still works --------------

  it('still allows a non-owner developer to PATCH in_progress → done when the LATEST run is completed (regression guard)', async () => {
    // Make sure the new latest-run anchoring only narrows the bypass
    // shape and does not regress the documented "completed run lets
    // a member close the task" flow on the normal in_progress path.
    // The only completed run is the latest activity on the task.
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/602';
    const task = await newTask({ prUrl });
    await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        status: 'completed',
        executorType: 'agent',
        executorName: agentName,
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(Date.now() - 60_000),
        endedAt: new Date(),
      },
    });

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: developerName,
        body: { status: 'done' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(200);
    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('done');
  });
});

// ---------------------------------------------------------------
// 6. R-192 awaiting_evidence → cancelled is owner-or-assignee only
//    (closes #1431)
// ---------------------------------------------------------------
//
// `awaiting_evidence → cancelled` is the documented assignee-release
// escape hatch: "this task will never pass the R-192 gate, give up
// and re-create instead". Pre-fix, the only auth requirement on the
// PATCH route was `requireProjectRole` (member+), so ANY project
// member could PATCH another member's or an agent's parked task to
// `cancelled`, silently discarding the prior execution run's
// evidence and closing the loop on someone else's work. The fix
// restricts this transition to the project owner (administrative
// close) or the current task assignee (legitimate self-release).

describe('R-192: awaiting_evidence → cancelled is owner-or-assignee only (closes #1431)', () => {
  const otherDeveloper = 'r192-cancel-bypasser';
  const otherAgent = 'r192-cancel-bypass-agent';
  const humanAssignee = 'r192-cancel-human';

  beforeAll(async () => {
    await testPrisma.projectMember.upsert({
      where: { projectId_name: { projectId, name: otherDeveloper } },
      update: { role: 'developer', type: 'human' },
      create: { projectId, name: otherDeveloper, role: 'developer', type: 'human' },
    });
    await testPrisma.projectMember.upsert({
      where: { projectId_name: { projectId, name: otherAgent } },
      update: { role: 'developer', type: 'agent' },
      create: { projectId, name: otherAgent, role: 'developer', type: 'agent' },
    });
    await testPrisma.projectMember.upsert({
      where: { projectId_name: { projectId, name: humanAssignee } },
      update: { role: 'developer', type: 'human' },
      create: { projectId, name: humanAssignee, role: 'developer', type: 'human' },
    });
  });

  it('rejects a non-owner non-assignee developer cancelling an agent-assigned parked task', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/700';
    const task = await newTask({ prUrl });
    await testPrisma.task.update({
      where: { id: task.id },
      data: { status: 'awaiting_evidence' },
    });

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: otherDeveloper,
        body: { status: 'cancelled' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(JSON.stringify(json)).toMatch(/owner|assignee/i);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('awaiting_evidence');
  });

  it('rejects another agent (not the assignee) cancelling a parked task', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/701';
    const task = await newTask({ prUrl });
    await testPrisma.task.update({
      where: { id: task.id },
      data: { status: 'awaiting_evidence' },
    });

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: otherAgent,
        body: { status: 'cancelled' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(403);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('awaiting_evidence');
  });

  it('allows the assignee (agent) to cancel their own parked task', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/702';
    const task = await newTask({ prUrl });
    await testPrisma.task.update({
      where: { id: task.id },
      data: { status: 'awaiting_evidence' },
    });

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: agentName,
        body: { status: 'cancelled' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('cancelled');
  });

  it('allows a human assignee to cancel their own parked task', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/703';
    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'r192-cancel-human-task',
        type: 'code',
        priority: 'p1',
        status: 'awaiting_evidence',
        assignee: humanAssignee,
        assigneeType: 'human',
        boundPlanVersion: planVersion,
        agentConstraints: [],
        planDeliverableRefs: [deliverableA.slug],
        prUrl,
      },
    });

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: humanAssignee,
        body: { status: 'cancelled' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('cancelled');
  });

  it('allows the project owner to cancel a parked task assigned to someone else (regression)', async () => {
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/704';
    const task = await newTask({ prUrl });
    await testPrisma.task.update({
      where: { id: task.id },
      data: { status: 'awaiting_evidence' },
    });

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: owner,
        body: { status: 'cancelled' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('cancelled');
  });

  it('does not gate non-awaiting_evidence sources (todo → cancelled by non-assignee still works)', async () => {
    // Defense-in-depth check: the new guard is scoped strictly to
    // the `awaiting_evidence` source state. Cancelling from `todo`
    // — which has no completed-run evidence to discard — keeps its
    // pre-fix behaviour so this finding does not silently morph
    // into a much broader policy change. The repo currently treats
    // `todo → cancelled` as a member-allowed operation; if that
    // policy is later tightened it belongs in a separate finding.
    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'r192-todo-cancel-scope-task',
        type: 'code',
        priority: 'p1',
        status: 'todo',
        assignee: agentName,
        assigneeType: 'agent',
        boundPlanVersion: planVersion,
        agentConstraints: [],
        planDeliverableRefs: [deliverableA.slug],
      },
    });

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: otherDeveloper,
        body: { status: 'cancelled' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------
// 6. R-192 awaiting_evidence → in_progress|blocked is owner-or-assignee
//    (closes #1429 — third-party bypass of PR #1428's cancel gate)
// ---------------------------------------------------------------
//
// PR #1428 added an owner-or-assignee gate for the direct
// `awaiting_evidence → cancelled` PATCH (closes #1426). The gate is
// bypassable on its own because the other two non-`done` exits out of
// `awaiting_evidence` (`→ in_progress`, `→ blocked`) carry no identity
// check on master — any project member can flip the parked task out of
// `awaiting_evidence` first, then run `in_progress → cancelled` (or
// `blocked → in_progress → cancelled`) where the owner-or-assignee gate
// no longer fires because the source state is no longer
// `awaiting_evidence`. This describe pins the fix: the same
// owner-or-assignee gate now also covers the in_progress / blocked
// exits, so the bypass is rejected at step 1 and the parked task stays
// parked.

describe('R-192: awaiting_evidence → in_progress|blocked is owner-or-assignee only (closes #1429)', () => {
  const thirdParty = 'r1429-third-party';
  const humanAssignee = 'r1429-human-assignee';

  beforeAll(async () => {
    await testPrisma.projectMember.upsert({
      where: { projectId_name: { projectId, name: thirdParty } },
      update: { role: 'developer', type: 'human' },
      create: { projectId, name: thirdParty, role: 'developer', type: 'human' },
    });
    await testPrisma.projectMember.upsert({
      where: { projectId_name: { projectId, name: humanAssignee } },
      update: { role: 'developer', type: 'human' },
      create: { projectId, name: humanAssignee, role: 'developer', type: 'human' },
    });
  });

  async function parkedAgentTask(prSuffix: number) {
    const prUrl = `https://github.com/plansync-test/r192-repo/pull/${1429000 + prSuffix}`;
    const task = await newTask({ prUrl });
    await testPrisma.task.update({
      where: { id: task.id },
      data: { status: 'awaiting_evidence' },
    });
    // Mirror the real "parked" shape: an old completed run is always on
    // file when a task is in `awaiting_evidence`.
    await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        status: 'completed',
        executorType: 'agent',
        executorName: agentName,
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(Date.now() - 60_000),
        endedAt: new Date(),
      },
    });
    return task;
  }

  it('rejects a third-party developer PATCHing awaiting_evidence → in_progress (the bypass step 1)', async () => {
    const task = await parkedAgentTask(1);

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: thirdParty,
        body: { status: 'in_progress' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(JSON.stringify(json)).toMatch(/owner or task assignee/i);

    // Task must remain parked — the bypass chain is rejected at step 1.
    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('awaiting_evidence');
  });

  it('rejects a third-party developer PATCHing awaiting_evidence → blocked (the bypass step 1, blocked variant)', async () => {
    const task = await parkedAgentTask(2);

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: thirdParty,
        body: { status: 'blocked' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(403);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('awaiting_evidence');
  });

  it('allows the agent assignee to PATCH awaiting_evidence → in_progress (legitimate self-resume)', async () => {
    // The agent assignee resuming their own parked task is the
    // canonical legitimate use of this transition (alongside owner
    // reopening). Make sure the new gate does not regress it.
    const task = await parkedAgentTask(3);

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: agentName,
        body: { status: 'in_progress' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('in_progress');
  });

  it('allows a human assignee to PATCH awaiting_evidence → blocked on their own task', async () => {
    // Sibling regression for the assignee path: a human assignee
    // marking their own parked task `blocked` (drift / external block
    // landed while they were trying to round up evidence) is a
    // documented legitimate exit and must remain allowed.
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/1429004';
    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'r1429-human-blocked',
        type: 'code',
        priority: 'p1',
        status: 'awaiting_evidence',
        assignee: humanAssignee,
        assigneeType: 'human',
        boundPlanVersion: planVersion,
        agentConstraints: [],
        planDeliverableRefs: [deliverableA.slug],
        prUrl,
      },
    });

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: humanAssignee,
        body: { status: 'blocked' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('blocked');
  });

  it('allows the project owner to PATCH awaiting_evidence → in_progress (owner administrative override)', async () => {
    // Belt-and-braces: the original R-192 recovery story explicitly
    // documents owner-reopens-for-more-work as a legitimate exit, and
    // the suite at "R-192 recovery" already covers this — but we
    // re-assert here under the #1429 describe so the new gate's
    // owner-allow branch is exercised next to its developer-reject
    // siblings.
    const task = await parkedAgentTask(5);

    const res = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: owner,
        body: { status: 'in_progress' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(200);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('in_progress');
  });

  it('rejects the full bypass chain at step 1 so the third party never reaches `in_progress → cancelled`', async () => {
    // Reproduce the exact #1429 bypass shape end-to-end:
    //   1. third party PATCHes awaiting_evidence → in_progress  ← must reject
    //   2. (if step 1 succeeded) third party PATCHes in_progress → cancelled
    //
    // The fix closes step 1, so the chain never reaches step 2. We do
    // not assert anything about step 2 here — the contract is that
    // step 1 is unreachable.
    const task = await parkedAgentTask(6);

    const step1 = await taskPatch(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        userName: thirdParty,
        body: { status: 'in_progress' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(step1.status).toBe(403);

    // The task is still parked — `in_progress → cancelled` is no
    // longer reachable from this caller because the source state
    // never moved.
    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('awaiting_evidence');
  });
});

// ---------------------------------------------------------------
// 7. R-192 POST /runs atomic lift+create (closes #1367)
// ---------------------------------------------------------------
//
// Pre-fix the route did the `awaiting_evidence → in_progress` lift
// (auto-commit `prisma.task.updateMany`) and the new running run
// insert (auto-commit `prisma.executionRun.create`) as two
// independent writes. Between those two commits, the database was
// observably in the exact bypass shape #1306 set out to close:
//
//     task.status = 'in_progress'           ← lift committed
//     latestRun.status = 'completed'        ← new run not yet inserted
//
// A concurrent non-owner `PATCH /tasks/:id status=done` racing into
// that TOCTOU window would slip past both the explicit
// `awaiting_evidence` source guard (source is now `in_progress`) and
// the `hasCompletedRun` shortcut (old completed run is still the
// latest), bypassing R-192.
//
// The fix wraps the lift + run-create in a single
// `prisma.$transaction`. With atomic commit, the intermediate state
// is never visible to other readers, and if the run-create fails
// (P2002 race against the partial unique index) the lift rolls back
// — the task stays parked rather than getting silently bumped out
// of `awaiting_evidence` on a failed start.

describe('R-192: POST /runs lift + run-create commit atomically (closes #1367)', () => {
  it('rolls back the awaiting_evidence → in_progress lift when the new running-run insert fails', async () => {
    // Setup the parked-task shape used by every #1306 / #1367 test
    // in this file: an awaiting_evidence task with the old completed
    // run on file.
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/1367';
    const task = await newTask({ prUrl });
    await testPrisma.task.update({
      where: { id: task.id },
      data: { status: 'awaiting_evidence' },
    });
    await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        status: 'completed',
        executorType: 'agent',
        executorName: agentName,
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(Date.now() - 180_000),
        endedAt: new Date(Date.now() - 120_000),
      },
    });
    // Pre-seed a `running` run for the same task so the partial
    // unique index `execution_runs_one_running_per_task` will fire
    // P2002 when the route's transaction tries to insert its new
    // running run. Real concurrent races against this index are the
    // failure mode the transaction must defend against.
    await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        status: 'running',
        executorType: 'agent',
        executorName: agentName,
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(Date.now() - 30_000),
      },
    });

    // The early mutex check inside POST /runs would normally see the
    // pre-seeded running run and short-circuit with 409 BEFORE the
    // transaction ever runs — which would defeat the atomicity test
    // because the lift would never be attempted. Stub the production
    // prisma's `executionRun.findFirst` to return null for that one
    // call so the route reaches the transactional lift+create path,
    // where the partial unique index then surfaces the P2002 the
    // rollback must defend against.
    const restoreFindFirst = await spyOnProductionPrisma('executionRun', 'findFirst', (orig) => {
      let bypassed = false;
      return ((args: Parameters<typeof orig>[0]) => {
        // First call from the route is the mutex check (matches by
        // status: 'running'). Skip it so we reach the transaction.
        // Every other call goes through to the real client.
        const where = (args as { where?: { status?: string } } | undefined)?.where;
        if (!bypassed && where?.status === 'running') {
          bypassed = true;
          return Promise.resolve(null);
        }
        return (orig as (a: typeof args) => unknown)(args) as ReturnType<typeof orig>;
      }) as typeof orig;
    });

    try {
      const res = await runsStartPost(
        makeReq(`/api/projects/${projectId}/tasks/${task.id}/runs`, {
          method: 'POST',
          userName: agentName,
          body: { executorName: agentName, executorType: 'agent' },
        }),
        { params: Promise.resolve({ projectId, taskId: task.id }) },
      );
      // The route catches P2002 and surfaces it as STATE_CONFLICT
      // (409). With the fix, the failed insert inside the
      // transaction also rolls back the lift; pre-fix the route
      // returned the same 409 status code but had ALREADY committed
      // the lift, leaving the task in `in_progress` with the old
      // completed run still latest — the bypass shape.
      expect(res.status).toBe(409);
    } finally {
      restoreFindFirst();
    }

    // The atomicity contract: the lift must have rolled back. The
    // task must still be parked in `awaiting_evidence`, NOT silently
    // bumped to `in_progress` by a failed start.
    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('awaiting_evidence');

    // Sanity: only the original two runs (old completed + the pre-seeded
    // running run) exist. The transaction must not have leaked a partial
    // insert.
    const runs = await testPrisma.executionRun.findMany({
      where: { taskId: task.id },
      orderBy: { startedAt: 'asc' },
      select: { status: true },
    });
    expect(runs.map((r) => r.status).sort()).toEqual(['completed', 'running']);
  });

  it('still produces the expected post-state on the happy path: task=in_progress AND latest run=running', async () => {
    // Regression guard for the post-fix happy path. After the route
    // returns successfully, the database must be in the shape the
    // PATCH /tasks/:id `hasCompletedRun` check expects (latest run is
    // the new `running` row, not the old completed one), so the
    // R-192 gate on the PATCH route stays effective.
    const prUrl = 'https://github.com/plansync-test/r192-repo/pull/1367-happy';
    const task = await newTask({ prUrl });
    await testPrisma.task.update({
      where: { id: task.id },
      data: { status: 'awaiting_evidence' },
    });
    await testPrisma.executionRun.create({
      data: {
        taskId: task.id,
        status: 'completed',
        executorType: 'agent',
        executorName: agentName,
        boundPlanVersion: planVersion,
        taskPackSnapshot: {},
        startedAt: new Date(Date.now() - 120_000),
        endedAt: new Date(Date.now() - 60_000),
      },
    });

    const res = await runsStartPost(
      makeReq(`/api/projects/${projectId}/tasks/${task.id}/runs`, {
        method: 'POST',
        userName: agentName,
        body: { executorName: agentName, executorType: 'agent' },
      }),
      { params: Promise.resolve({ projectId, taskId: task.id }) },
    );
    expect(res.status).toBe(201);

    const after = await testPrisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('in_progress');

    // The new running run must be the latest by `startedAt`, so the
    // PATCH /tasks/:id latest-run anchoring (from #1306) sees
    // `running`, not `completed`, and the bypass shortcut stays
    // closed for a concurrent non-owner PATCH that arrives after the
    // transaction commits.
    const latest = await testPrisma.executionRun.findFirst({
      where: { taskId: task.id },
      orderBy: { startedAt: 'desc' },
      select: { status: true },
    });
    expect(latest?.status).toBe('running');
  });
});
