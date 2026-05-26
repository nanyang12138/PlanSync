// R-156: Deliverables timeline page.
//
// The remediation plan describes this as
// `packages/api/src/app/projects/[projectId]/plans/[planId]/deliverables/page.tsx`
// but the existing Web UI uses `[id]` as the project route segment and keeps
// plan-scoped views under `[id]/plans/...` (see `[id]/plans/page.tsx`).
// We follow the existing convention so the new page nests inside the same
// shell as the plans page and the `?plan=` query parameter selects which
// plan's deliverables are shown — defaulting to the active plan when
// omitted.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireProjectMembershipOrNotFound } from '@/lib/ssr-auth';
import { ArrowLeft, Layers } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { SectionShell } from '@/components/shared/section-shell';
import { RealtimeWrapper } from '@/components/realtime-wrapper';
import {
  DeliverableTimeline,
  type DeliverableWithLinks,
} from '@/components/plan/deliverable-timeline';

export default async function ProjectDeliverablesPage({
  params: paramsPromise,
  searchParams: searchParamsPromise,
}: {
  // Next.js 15: page params + searchParams are both async (R-131 / G3).
  params: Promise<{ id: string }>;
  searchParams: Promise<{ plan?: string }>;
}) {
  const params = await paramsPromise;
  const searchParams = await searchParamsPromise;
  // Closes #1258: deliverables, task titles and per-deliverable comments
  // are project-confidential. Refuse to render to anyone who is not a
  // member, using `notFound()` (404) instead of 403 so we don't leak
  // project existence to outsiders who only know the projectId.
  await requireProjectMembershipOrNotFound(params.id);

  const project = await prisma.project.findUnique({
    where: { id: params.id },
    select: { id: true, name: true },
  });
  if (!project) notFound();

  // Choose plan: explicit ?plan=… wins, otherwise default to the active
  // plan (the same convention `/projects/[id]/plans/page.tsx` uses).
  const allPlans = await prisma.plan.findMany({
    where: { projectId: params.id },
    select: { id: true, version: true, status: true, title: true },
    orderBy: { version: 'desc' },
  });
  const activePlan = allPlans.find((p) => p.status === 'active') ?? allPlans[0];
  const requestedPlanId =
    searchParams.plan && allPlans.some((p) => p.id === searchParams.plan)
      ? searchParams.plan
      : activePlan?.id;

  const selectedPlan = requestedPlanId
    ? await prisma.plan.findUnique({
        where: { id: requestedPlanId },
        select: { id: true, version: true, status: true, title: true, projectId: true },
      })
    : null;

  // Cross-project guard: refuse to render even if the caller hand-crafts a
  // planId that belongs to another project. The API enforces this too
  // (R-041) but the page-level check avoids a 404 from a hostile URL.
  if (selectedPlan && selectedPlan.projectId !== params.id) notFound();

  let deliverables: DeliverableWithLinks[] = [];
  if (selectedPlan) {
    const rows = await prisma.planDeliverable.findMany({
      where: { planId: selectedPlan.id },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: {
        taskLinks: {
          include: {
            task: { select: { id: true, title: true, status: true } },
          },
        },
        supersedes: { select: { id: true, slug: true, title: true } },
        supersededBy: { select: { id: true, slug: true, title: true } },
      },
    });
    // Per-deliverable comments — single round trip filtered by the set of
    // ids we just loaded so the page does not N+1 the comments table.
    const comments = await prisma.planComment.findMany({
      where: {
        planId: selectedPlan.id,
        deliverableId: { in: rows.map((r) => r.id) },
      },
      orderBy: { createdAt: 'asc' },
    });
    const byDeliverable = new Map<string, typeof comments>();
    for (const c of comments) {
      if (!c.deliverableId) continue;
      const list = byDeliverable.get(c.deliverableId) ?? [];
      list.push(c);
      byDeliverable.set(c.deliverableId, list);
    }
    deliverables = rows.map((row) => ({
      ...row,
      comments: byDeliverable.get(row.id) ?? [],
    }));
  }

  return (
    <RealtimeWrapper projectId={params.id}>
      <div className="page-shell">
        <PageHeader
          breadcrumbs={
            <Link
              href={`/projects/${params.id}/plans${selectedPlan ? `?plan=${selectedPlan.id}` : ''}`}
              className="flex items-center gap-1 text-xs text-fg-subtle hover:text-fg transition-colors font-medium"
              title="Back to plan"
            >
              <ArrowLeft className="h-3.5 w-3.5 text-fg-subtle" />
              {project.name}
            </Link>
          }
          title={<span className="text-sm font-bold text-fg">Deliverables</span>}
          navigation={[]}
        />

        <main className="page-container">
          <SectionShell
            title={
              selectedPlan
                ? `Deliverables for ${selectedPlan.title} (v${selectedPlan.version})`
                : 'Deliverables'
            }
            icon={<Layers className="h-5 w-5" />}
            action={
              selectedPlan ? (
                <span className="text-sm text-fg-muted">
                  {deliverables.length} {deliverables.length === 1 ? 'deliverable' : 'deliverables'}
                </span>
              ) : null
            }
          >
            {!selectedPlan ? (
              <div className="py-6 text-center">
                <p className="text-base font-semibold text-fg">No plan to render</p>
                <p className="mt-1 text-sm text-fg-muted">
                  Create or activate a plan from the project page before opening this view.
                </p>
              </div>
            ) : (
              <DeliverableTimeline
                projectId={params.id}
                planId={selectedPlan.id}
                deliverables={deliverables}
              />
            )}
          </SectionShell>
        </main>
      </div>
    </RealtimeWrapper>
  );
}
