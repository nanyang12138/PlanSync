/**
 * R-192 / P0-0: evidence-pipeline END-TO-END seam test.
 *
 * This is the test the whole P0-0 fix exists for. It proves the full
 * chain is actually WIRED, not just that each piece works in isolation:
 *
 *   domain_events(github_push)                       (as R-190 persists it)
 *     ──▶ registerGithubOutboxHandlers()             (run-worker startup)
 *     ──▶ processPendingOutboxEvents()               (the outbox consumer tick)
 *     ──▶ handleGithubPushEvent → linkCommitsFromPushPayload
 *     ──▶ commit_deliverable_links (matchedBy='glob')
 *     ──▶ deriveTaskCompletionState                  (R-192 evidence gate)
 *     ──▶ task: awaiting_evidence → done
 *
 * Before this fix the consumer had NO handler registered for github_push,
 * so it skipped every push row, no links were ever written, and a gated
 * task stayed parked in `awaiting_evidence` forever. The money assertions
 * below are the BEFORE/AFTER around `processPendingOutboxEvents()`: the
 * same task is `awaiting_evidence` before the consumer runs and `done`
 * after — and the ONLY thing that changed is the consumer dispatching the
 * push row through the now-registered handler.
 *
 * Cross-test note: `processPendingOutboxEvents()` scans `domain_events`
 * globally (it has no project filter). Under the default parallel test
 * pool it may also dispatch sibling tests' undelivered github_push rows —
 * this is harmless (the linker is idempotent and scoped per-row projectId,
 * and no sibling asserts the `deliveredAt` flag), and every assertion here
 * is scoped to THIS test's project / SHAs so a sibling's rows can never
 * change the outcome. A project-scoped consumer scan is a documented
 * follow-up, not part of P0-0.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestProject,
  createActivePlan,
  cleanupProject,
  testPrisma,
} from '../helpers/request';
import { processPendingOutboxEvents, _resetOutboxHandlersForTests } from '@/lib/outbox-consumer';
import { registerGithubOutboxHandlers } from '@/lib/git/register-outbox-handlers';
import { deriveTaskCompletionState } from '@/lib/task-state-machine';

const owner = 'r192-e2e-owner';
const agentName = 'r192-e2e-agent';
const repoSlug = 'plansync-test/r192-e2e-repo';

let projectId: string;
let planVersion: number;
let deliverable: { id: string; slug: string };

function hex40(seed: string): string {
  // Build a 40-char lowercase-hex SHA, unique per test run so we never
  // collide with sibling tests' commit_deliverable_links rows.
  const base = (seed + Math.random().toString(16).slice(2) + Date.now().toString(16)).replace(
    /[^0-9a-f]/g,
    '0',
  );
  return base.padEnd(40, '0').slice(0, 40);
}

beforeAll(async () => {
  ({ projectId } = await createTestProject(owner));
  // R-192 opt-in: the project-level master switch for the git evidence gate.
  await testPrisma.project.update({ where: { id: projectId }, data: { githubRepo: repoSlug } });

  const { planId, version } = await createActivePlan(projectId, owner);
  planVersion = version;

  const d = await testPrisma.planDeliverable.create({
    data: {
      planId,
      slug: 'login-feature',
      title: 'Login feature',
      body: 'all TS under src/feature',
      refType: 'file_glob',
      refUri: 'src/feature/**/*.ts',
      status: 'active',
    },
  });
  deliverable = { id: d.id, slug: d.slug };

  // Register the github_push → linker handler exactly as run-worker does.
  _resetOutboxHandlersForTests();
  registerGithubOutboxHandlers();
});

afterAll(async () => {
  _resetOutboxHandlersForTests();
  await cleanupProject(projectId);
});

describe('R-192 / P0-0: github_push → commit links → task done seam', () => {
  it('flips a gated task from awaiting_evidence to done only after the outbox consumer dispatches the push event', async () => {
    const mergeCommitSha = hex40('merge');
    const constituentSha = hex40('commit');
    const prUrl = `https://github.com/${repoSlug}/pull/${Math.floor(Math.random() * 1e6)}`;

    const task = await testPrisma.task.create({
      data: {
        projectId,
        title: 'r192-e2e-task',
        type: 'code',
        priority: 'p1',
        status: 'in_progress',
        assignee: agentName,
        assigneeType: 'agent',
        boundPlanVersion: planVersion,
        agentConstraints: [],
        planDeliverableRefs: [deliverable.slug],
        prUrl,
      },
    });

    const deriveInput = {
      projectId,
      task: {
        id: task.id,
        prUrl: task.prUrl,
        planDeliverableRefs: task.planDeliverableRefs,
        boundPlanVersion: planVersion,
      },
    };

    // ---- Stage 0: nothing observed yet → awaiting_evidence ----------
    const before = await deriveTaskCompletionState(deriveInput);
    expect(before.status).toBe('awaiting_evidence');
    expect(before.missing.map((m) => m.code)).toContain('pr_merged');

    // ---- Stage 1: GitHub delivers the merged PR + the push to main.
    // These are persisted exactly as R-190's webhook receiver writes
    // them: the outer envelope is the R-160 domain-event shape, the raw
    // GitHub body lives at data.payload.
    await testPrisma.domainEvent.create({
      data: {
        eventType: 'github_pull_request',
        projectId,
        payload: {
          type: 'github_pull_request',
          projectId,
          data: {
            deliveryId: `pr-${Math.random().toString(36).slice(2)}`,
            repository: repoSlug,
            payload: {
              action: 'closed',
              pull_request: {
                html_url: prUrl,
                merged: true,
                merge_commit_sha: mergeCommitSha,
                head: { sha: hex40('head') },
                base: { ref: 'main' },
              },
            },
          },
        },
      },
    });
    const pushEvent = await testPrisma.domainEvent.create({
      data: {
        eventType: 'github_push',
        projectId,
        payload: {
          type: 'github_push',
          projectId,
          data: {
            deliveryId: `push-${Math.random().toString(36).slice(2)}`,
            repository: repoSlug,
            payload: {
              ref: 'refs/heads/main',
              head_commit: { id: mergeCommitSha },
              commits: [
                {
                  id: constituentSha,
                  message: 'feat: implement login',
                  added: ['src/feature/login.ts'],
                  modified: [],
                  removed: [],
                },
              ],
            },
          },
        },
      },
    });

    // ---- Stage 2: push event is persisted but UNPROCESSED. No links
    // exist yet, so the gate is still missing deliverable_evidence.
    // (This is exactly the broken state before P0-0: the row sits in
    // domain_events and nothing ever links it.)
    const linksBefore = await testPrisma.commitDeliverableLink.findMany({
      where: { projectId, sha: constituentSha },
    });
    expect(linksBefore).toHaveLength(0);
    const midway = await deriveTaskCompletionState(deriveInput);
    expect(midway.status).toBe('awaiting_evidence');
    expect(midway.missing.map((m) => m.code)).toContain('deliverable_evidence');

    // ---- Stage 3: the outbox consumer ticks. THIS is the seam under
    // test — with the handler registered, the github_push row is now
    // dispatched to the linker instead of being skipped.
    await processPendingOutboxEvents();

    // The push row was delivered (not left skipped/undelivered).
    const pushAfter = await testPrisma.domainEvent.findUnique({ where: { id: pushEvent.id } });
    expect(pushAfter?.deliveredAt).not.toBeNull();

    // A glob-matched link now exists for the constituent commit.
    const linksAfter = await testPrisma.commitDeliverableLink.findMany({
      where: { projectId, sha: constituentSha },
    });
    expect(linksAfter).toHaveLength(1);
    expect(linksAfter[0]).toMatchObject({
      deliverableId: deliverable.id,
      matchedBy: 'glob',
      matchedRef: 'src/feature/login.ts',
    });

    // ---- Stage 4: with real, in-scope, PR-attributable evidence, the
    // gate now lets the task through.
    const after = await deriveTaskCompletionState(deriveInput);
    expect(after.status).toBe('done');
    expect(after.missing).toEqual([]);
  });
});
