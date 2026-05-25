import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma as defaultPrisma } from './prisma';

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * R-153: keep `task_deliverable_links` in sync with the legacy
 * `Task.planDeliverableRefs` slug array.
 *
 * The write paths (task POST / PATCH) accept a slug list — the same
 * human-friendly contract owners and the CLI have used since drift v2 was
 * introduced. This helper resolves each slug against the task's bound plan
 * and rewrites the link table so the two representations stay coherent.
 *
 * - Slugs that resolve to a `PlanDeliverable` row on the bound plan produce
 *   a link.
 * - Slugs that do NOT match are silently dropped from the link table; the
 *   slug stays in `planDeliverableRefs` so the owner can see the unresolved
 *   reference in `task_pack` (e.g. for a plan version that pre-dates R-150
 *   where no `PlanDeliverable` rows exist yet, the array column is the only
 *   source of truth and the link table remains empty — drift-engine's
 *   classifier already treats an empty refs list as the conservative
 *   "depends on all" sentinel, so the behaviour is unchanged from before
 *   this migration).
 * - Calling with an empty array clears the link table for that task.
 *
 * Idempotent: pass the same `slugs` twice and the second call is a no-op.
 */
export async function syncTaskDeliverableLinks(
  tx: Tx | undefined,
  args: {
    taskId: string;
    projectId: string;
    boundPlanVersion: number;
    slugs: string[];
  },
): Promise<void> {
  const db = tx ?? defaultPrisma;
  const slugs = Array.from(
    new Set(args.slugs.filter((s) => typeof s === 'string' && s.length > 0)),
  );

  if (slugs.length === 0) {
    await db.taskDeliverableLink.deleteMany({ where: { taskId: args.taskId } });
    return;
  }

  // Resolve slugs against the bound plan version. Use `findFirst` over
  // (projectId, version) because the (projectId, version) unique index on
  // plans is what already backs `Task.boundPlan` (R-083).
  const plan = await db.plan.findFirst({
    where: { projectId: args.projectId, version: args.boundPlanVersion },
    select: { id: true },
  });
  if (!plan) {
    await db.taskDeliverableLink.deleteMany({ where: { taskId: args.taskId } });
    return;
  }

  const deliverables = await db.planDeliverable.findMany({
    where: { planId: plan.id, slug: { in: slugs } },
    select: { id: true },
  });
  const targetIds = new Set(deliverables.map((d) => d.id));

  const existing = await db.taskDeliverableLink.findMany({
    where: { taskId: args.taskId },
    select: { deliverableId: true },
  });
  const existingIds = new Set(existing.map((l) => l.deliverableId));

  const toAdd = [...targetIds].filter((id) => !existingIds.has(id));
  const toRemove = [...existingIds].filter((id) => !targetIds.has(id));

  if (toRemove.length > 0) {
    await db.taskDeliverableLink.deleteMany({
      where: { taskId: args.taskId, deliverableId: { in: toRemove } },
    });
  }
  if (toAdd.length > 0) {
    await db.taskDeliverableLink.createMany({
      data: toAdd.map((deliverableId) => ({ taskId: args.taskId, deliverableId })),
      skipDuplicates: true,
    });
  }
}

/**
 * R-153: read back the deliverables linked to a task — joining through the
 * new middle table rather than reading slugs straight off the legacy column.
 * Used by `task_pack` and by drift-engine's per-task severity classifier.
 *
 * Returns deliverable id + slug + title + status so callers can both
 * recompute the "derived" slug array (for backwards compatibility) and
 * make UI decisions without a second round-trip.
 */
export async function fetchLinkedDeliverables(
  tx: Tx | undefined,
  taskId: string,
): Promise<Array<{ id: string; slug: string; title: string; status: string }>> {
  const db = tx ?? defaultPrisma;
  const links = await db.taskDeliverableLink.findMany({
    where: { taskId },
    include: {
      deliverable: { select: { id: true, slug: true, title: true, status: true } },
    },
  });
  return links.map((l) => l.deliverable);
}
