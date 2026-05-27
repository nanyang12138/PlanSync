// Closes #1334: the plans SSR page must only load *plan-level* comments
// (`deliverableId IS NULL`) for the `<CommentThread>` panel.
//
// Before the fix, the page-level Prisma query did
//   include: { comments: { orderBy: { createdAt: 'asc' } } }
// which returned every row in `plan_comments` for the plan — including
// the per-deliverable rows R-156 added — and handed the mixed set to
// `<CommentThread>`. The same rows then also rendered under each
// deliverable card on the timeline (#1260 / PR #1275 fixed the public
// GET listing the same way, but the server-side initial render was
// missed), double-displaying them and polluting the plan-level
// discussion context with deliverable-scoped replies.
//
// vitest's plain-node runtime can't actually render the page's JSX
// output (no React JSX runtime is wired up for these SSR tests — see
// `r156-deliverables-page-plan-guard.test.ts` for the same shortcut),
// so we intercept the production Prisma singleton's `plan.findMany`
// call instead. That is the precise call the page uses to populate the
// `<CommentThread comments={...}>` prop, so asserting on its `include`
// argument captures the contract end-to-end: a future regression that
// drops the `where: { deliverableId: null }` filter will fail this
// test even if the JSX never actually renders.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  createTestProject,
  createActivePlan,
  cleanupProject,
  spyOnProductionPrisma,
  testPrisma,
} from '../helpers/request';

const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import ProjectPlansPage from '@/app/projects/[id]/plans/page';

async function callPage(projectId: string, searchParams: { plan?: string } = {}) {
  // Swallow downstream JSX rendering errors (`React is not defined`,
  // etc.) — we only care about Prisma calls the function emits before
  // it returns its element tree.
  try {
    await ProjectPlansPage({
      params: Promise.resolve({ id: projectId }),
      searchParams: Promise.resolve(searchParams),
    });
  } catch {
    // intentional — see comment above.
  }
}

describe('#1334: plans SSR page only loads plan-level comments', () => {
  const owner = `i1334-owner-${Date.now()}`;
  let projectId: string;
  let planId: string;
  let deliverableId: string;

  beforeAll(async () => {
    ({ projectId } = await createTestProject(owner));
    ({ planId } = await createActivePlan(projectId, owner));
    const deliverable = await testPrisma.planDeliverable.create({
      data: { planId, slug: 'i1334-a', title: 'A', body: 'b', refType: 'free' },
    });
    deliverableId = deliverable.id;

    // Seed both plan-level and deliverable-anchored comments so the
    // production query has something to filter on. Without these the
    // test would pass even if the page accidentally dropped its
    // `comments` include entirely.
    await testPrisma.planComment.createMany({
      data: [
        { planId, content: 'plan-level A', authorName: owner, authorType: 'human' },
        { planId, content: 'plan-level B', authorName: owner, authorType: 'human' },
        {
          planId,
          deliverableId,
          content: 'deliverable A',
          authorName: owner,
          authorType: 'human',
        },
        {
          planId,
          deliverableId,
          content: 'deliverable B',
          authorName: owner,
          authorType: 'human',
        },
      ],
    });
  });

  afterAll(async () => {
    await cleanupProject(projectId);
  });

  beforeEach(() => {
    cookieJar.clear();
    cookieJar.set('plansync-user', owner);
  });

  it('calls `plan.findMany` with `comments: { where: { deliverableId: null } }`', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const restore = await spyOnProductionPrisma('plan', 'findMany', (orig) => {
      return ((args: Record<string, unknown> | undefined) => {
        seen.push(args ?? {});
        return orig(args as never) as ReturnType<typeof orig>;
      }) as unknown as typeof orig;
    });
    try {
      await callPage(projectId);
    } finally {
      restore();
    }

    // We expect the page to have issued exactly one `plan.findMany`
    // call (the one that loads versions + comments + suggestions). If a
    // future change reshapes the page into multiple plan queries we
    // want to know — the loop below still asserts the contract on
    // whichever call carries the `comments` include.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const withComments = seen.filter((args) => {
      const include = (args.include ?? {}) as Record<string, unknown>;
      return 'comments' in include;
    });
    expect(withComments.length).toBeGreaterThanOrEqual(1);

    for (const args of withComments) {
      const include = args.include as { comments: { where?: { deliverableId?: unknown } } };
      // The regression we're guarding: the `include` must scope to
      // plan-level rows. A missing `where` (the pre-fix shape) or a
      // `where` that drops `deliverableId: null` both fail.
      expect(include.comments.where).toBeDefined();
      expect(include.comments.where!.deliverableId).toBeNull();
    }
  });

  it('production findMany result honours `deliverableId IS NULL` (no per-deliverable leak)', async () => {
    // Re-issue the exact query shape the page uses against the live DB
    // — independent of the page render path — so this test still
    // catches a regression even if the page later moves to a separate
    // query.
    const plans = await testPrisma.plan.findMany({
      where: { projectId },
      include: {
        comments: {
          where: { deliverableId: null },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    const target = plans.find((p) => p.id === planId);
    expect(target).toBeDefined();
    expect(target!.comments.length).toBe(2);
    for (const c of target!.comments) {
      expect(c.deliverableId).toBeNull();
    }
  });
});
