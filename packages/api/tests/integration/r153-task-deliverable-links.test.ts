// R-153: Task → PlanDeliverable middle table.
//
// Verifies the two invariants the remediation plan calls out:
//
//   1. "rename slug 后 task 仍 join" — when the owner renames a
//      `PlanDeliverable.slug` for a plan version a task is bound to, the
//      task_pack response surfaces the NEW slug (because the link is
//      anchored on deliverable id, not on the slug string). The cached
//      `Task.planDeliverableRefs` slug array would, by itself, still show
//      the stale slug — this test pins down that the link-based join wins.
//
//   2. "drift severity 分项级别准确" — when drift severity is computed
//      per task, `refsFromTask` reads from the link rows, not from the
//      cached array. This is the structural change R-154 will lean on.
//
// Both invariants are exercised through the public, supported APIs
// (`syncTaskDeliverableLinks` for write-path sync, `buildTaskPack` for
// read-path projection, and a direct invocation of the internal
// `refsFromTask` projection mirrored by exercising `runDriftScan`).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('@/lib/email', () => ({
  sendMail: vi.fn(() => true),
  userEmail: (name: string) => `${name}@example.com`,
}));

import { buildTaskPack } from '@/lib/task-pack';
import { syncTaskDeliverableLinks, fetchLinkedDeliverables } from '@/lib/task-deliverable-links';
import { runDriftScan } from '@/lib/drift-engine';
import {
  createTestProject,
  cleanupProject,
  createActivePlan,
  testPrisma,
} from '../helpers/request';

describe('R-153: Task → PlanDeliverable link table', () => {
  const owner = 'r153-owner';
  let projectId: string;
  let planId: string;
  let planVersion: number;
  let deliverableId: string;
  let taskId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    const plan = await createActivePlan(projectId, owner);
    planId = plan.planId;
    planVersion = plan.version;

    const d = await testPrisma.planDeliverable.create({
      data: {
        planId,
        slug: 'auth/oidc-callback',
        title: 'OIDC callback',
        body: 'Implement OIDC callback handler',
        status: 'active',
      },
    });
    deliverableId = d.id;

    const t = await testPrisma.task.create({
      data: {
        projectId,
        title: 'Wire OIDC callback',
        type: 'code',
        priority: 'p1',
        status: 'todo',
        assignee: owner,
        assigneeType: 'human',
        boundPlanVersion: planVersion,
        planDeliverableRefs: ['auth/oidc-callback'],
      },
    });
    taskId = t.id;

    // Seed the link table the way the POST /tasks route would.
    await syncTaskDeliverableLinks(undefined, {
      taskId: t.id,
      projectId,
      boundPlanVersion: planVersion,
      slugs: t.planDeliverableRefs,
    });
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  it('seeds one link row per resolvable slug on the bound plan', async () => {
    const links = await fetchLinkedDeliverables(undefined, taskId);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      id: deliverableId,
      slug: 'auth/oidc-callback',
      title: 'OIDC callback',
      status: 'active',
    });
  });

  it('task_pack surfaces the renamed slug after the owner renames PlanDeliverable.slug', async () => {
    // Rename the deliverable in place — this is the "owner edits the plan
    // deliverable" path. The link row stays pointed at the same id, so the
    // join through `task_deliverable_links → plan_deliverables` returns the
    // NEW slug. If task_pack were to read from the cached
    // `Task.planDeliverableRefs` array, this assertion would fail.
    await testPrisma.planDeliverable.update({
      where: { id: deliverableId },
      data: { slug: 'auth/oidc-callback-v2', title: 'OIDC callback (v2)' },
    });

    const pack = await buildTaskPack(taskId, projectId);
    expect(pack).not.toBeNull();
    expect(pack!.task.planDeliverableRefs).toEqual(['auth/oidc-callback-v2']);
    expect(pack!.task.linkedDeliverables).toEqual([
      expect.objectContaining({
        id: deliverableId,
        slug: 'auth/oidc-callback-v2',
        title: 'OIDC callback (v2)',
        status: 'active',
      }),
    ]);
  });

  it('runDriftScan classifies per-deliverable using the linked slug, not the cached slug array', async () => {
    // Activate a new plan version whose `deliverables: String[]` legacy
    // column REMOVES the linked deliverable (the renamed slug from the
    // previous test). The task references that deliverable through its
    // link row — `refsFromTask` must read the CURRENT linked slug
    // ('auth/oidc-callback-v2') so the diff-classifier treats the
    // removal as a per-task breaking change.
    //
    // The legacy `Task.planDeliverableRefs` column still says
    // 'auth/oidc-callback' (the pre-rename slug). If `refsFromTask`
    // erroneously fell back to that column, the diff would compare
    // ['auth/oidc-callback'] against ['leftover'] and miss the removal
    // of 'auth/oidc-callback-v2' — the alert would degrade to 'low'.
    const newPlan = await testPrisma.$transaction(async (tx) => {
      await tx.plan.updateMany({
        where: { projectId, status: 'active' },
        data: { status: 'superseded' },
      });
      return tx.plan.create({
        data: {
          projectId,
          title: 'Test Plan v2',
          goal: 'Test goal',
          scope: 'Test scope',
          version: planVersion + 1,
          status: 'active',
          createdBy: owner,
          activatedAt: new Date(),
          activatedBy: owner,
          deliverables: ['leftover'],
        },
      });
    });

    // The original plan stored its deliverables on the legacy String[]
    // column too — make sure it actually lists the v2 slug so the diff
    // computes "v2 → removed" rather than "" → "".
    await testPrisma.plan.update({
      where: { id: planId },
      data: { deliverables: ['auth/oidc-callback-v2'] },
    });

    const { alerts } = await runDriftScan(testPrisma, projectId, newPlan.version);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].taskId).toBe(taskId);
    // The linked deliverable was removed from the new plan version, and
    // the classifier saw the linked slug as the task's reference — so
    // this is a breaking change for THIS task. severity 'high' maps to
    // classifier 'breaking' in `severityToDb`.
    expect(alerts[0].severity).toBe('high');
    expect(alerts[0].structuralSeverity).toBe('breaking');
  });
});
