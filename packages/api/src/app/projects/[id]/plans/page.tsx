import Link from 'next/link';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { notFound } from 'next/navigation';
import { PlanTimeline } from '@/components/plan/plan-timeline';
import { PlanWorkspaceClient } from '@/components/plan/plan-workspace-client';
import { SuggestionPanel } from '@/components/plan/suggestion-panel';
import { CommentThread } from '@/components/plan/comment-thread';
import { ArrowLeft, GitBranch, History } from 'lucide-react';
import { RealtimeWrapper } from '@/components/realtime-wrapper';
import { PageHeader } from '@/components/shared/page-header';
import { SectionShell } from '@/components/shared/section-shell';
import { getOrCreatePlanDiff, type PlanDiffResult } from '@/lib/ai/plan-diff';
import { Alert } from '@/components/ui/alert';

export default async function ProjectPlansPage({
  params: paramsPromise,
  searchParams: searchParamsPromise,
}: {
  // R-131 / G3 (Next.js 15): page params + searchParams are both async.
  params: Promise<{ id: string }>;
  searchParams: Promise<{ plan?: string }>;
}) {
  const params = await paramsPromise;
  const searchParams = await searchParamsPromise;
  const project = await prisma.project.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      name: true,
      members: {
        orderBy: { createdAt: 'asc' },
        select: { name: true, role: true, type: true },
      },
    },
  });
  if (!project) notFound();

  const plans = await prisma.plan.findMany({
    where: { projectId: params.id },
    include: {
      reviews: true,
      suggestions: { orderBy: { createdAt: 'desc' } },
      // Issue #1256 / R-156 follow-up: the plan-level "Comments" sidebar must
      // NOT show per-deliverable comments. Those belong to the deliverable
      // timeline page and have their own focused thread. Without this filter
      // a comment posted under deliverable X would also surface in the plan
      // sidebar, breaking the "one discussion per surface" mental model and
      // duplicating context across views. The deliverable comments still
      // load via the `[id]/plans/deliverables` route's own Prisma query.
      comments: { where: { deliverableId: null }, orderBy: { createdAt: 'asc' } },
    },
    orderBy: { version: 'desc' },
  });

  const activePlan = plans.find((p) => p.status === 'active');
  const defaultPlanId = activePlan?.id ?? plans[0]?.id;

  let selectedPlanId = searchParams.plan;
  if (!selectedPlanId || !plans.some((p) => p.id === selectedPlanId)) {
    selectedPlanId = defaultPlanId;
  }

  const selectedPlan = selectedPlanId ? plans.find((p) => p.id === selectedPlanId) : undefined;
  const previousPlan =
    selectedPlan && selectedPlan.version > 1
      ? (plans.find((p) => p.version === selectedPlan.version - 1) ?? null)
      : null;

  const timelinePlans = [...plans].sort((a, b) => a.version - b.version);
  // R-131 / G3 (Next.js 15): cookies() is now async.
  const currentUser = (await cookies()).get('plansync-user')?.value ?? 'anonymous';
  const currentMember = project.members.find((member) => member.name === currentUser);
  const isOwner = currentMember?.role === 'owner';
  const memberNames = project.members.map((member) => member.name);
  const nextVersion = (plans[0]?.version ?? 0) + 1;

  // Real plan diff: only attempt if we have both a previous and a selected plan, and the
  // selected plan is past v1. Cached entries return immediately; first call blocks on AI
  // (which is acceptable for a server component the user is already waiting on). If AI is
  // unavailable, we render the prior versions side-by-side without a synthesized summary.
  let planDiff: PlanDiffResult | null = null;
  let planDiffUnavailable = false;
  if (selectedPlan && previousPlan && selectedPlan.version > 1) {
    try {
      planDiff = await getOrCreatePlanDiff(params.id, previousPlan.id, selectedPlan.id);
      if (!planDiff) planDiffUnavailable = true;
    } catch {
      planDiffUnavailable = true;
    }
  }

  return (
    <RealtimeWrapper projectId={params.id}>
      <div className="page-shell">
        <PageHeader
          breadcrumbs={
            <Link
              href={`/projects/${params.id}`}
              className="flex items-center gap-1 text-xs text-fg-subtle hover:text-fg transition-colors font-medium"
              title={`Back to ${project.name}`}
            >
              <ArrowLeft className="h-3.5 w-3.5 text-fg-subtle" />
              {project.name}
            </Link>
          }
          title={<span className="text-sm font-bold text-fg">Plans</span>}
          navigation={[]}
        />

        <main className="page-container">
          <div className="space-y-6">
            <SectionShell
              title="Version History"
              icon={<History className="h-5 w-5" />}
              action={<span className="text-sm text-fg-muted">{plans.length} versions</span>}
            >
              {plans.length > 0 ? (
                <PlanTimeline
                  projectId={params.id}
                  plans={timelinePlans}
                  selectedPlanId={selectedPlanId ?? ''}
                />
              ) : (
                <div className="py-6 text-center">
                  <p className="text-base font-semibold text-fg">No plans yet</p>
                  <p className="mt-1 text-sm text-fg-muted">
                    {isOwner
                      ? 'Use the panel below to draft your first plan.'
                      : 'The project owner can create the first plan from this page.'}
                  </p>
                </div>
              )}
            </SectionShell>

            <div className="grid lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-7 space-y-6">
                {selectedPlan &&
                  previousPlan &&
                  selectedPlan.version > 1 &&
                  (planDiff || planDiffUnavailable) && (
                    <SectionShell
                      title={`Changes in v${selectedPlan.version}`}
                      description={`Compared to v${previousPlan.version}`}
                      icon={<GitBranch className="h-5 w-5" />}
                      className="border-subtle"
                    >
                      {planDiff ? (
                        <div className="space-y-4">
                          {planDiff.breakingChanges && (
                            <Alert intent="drift" title="Breaking changes detected">
                              Tasks bound to v{previousPlan.version} may need to be rebound to the
                              new plan. Open the project dashboard to resolve drift alerts.
                            </Alert>
                          )}

                          {planDiff.summary && (
                            <p className="text-sm text-fg-muted leading-relaxed">
                              {planDiff.summary}
                            </p>
                          )}

                          <div className="space-y-3">
                            {planDiff.changes.map((change, i) => {
                              const typeStyle =
                                change.type === 'added'
                                  ? 'bg-success-soft text-success-soft-fg'
                                  : change.type === 'removed'
                                    ? 'bg-danger-soft text-danger-soft-fg'
                                    : change.type === 'modified'
                                      ? 'bg-info-soft text-info-soft-fg'
                                      : 'bg-surface-2 text-fg-muted';
                              const glyph =
                                change.type === 'added'
                                  ? '+'
                                  : change.type === 'removed'
                                    ? '−'
                                    : change.type === 'modified'
                                      ? '~'
                                      : '•';
                              return (
                                <div key={i} className="flex items-start gap-3">
                                  <div
                                    className={`mt-0.5 shrink-0 h-5 w-5 rounded-full ${typeStyle} flex items-center justify-center text-[11px] font-bold`}
                                    aria-label={change.type}
                                  >
                                    {glyph}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs font-semibold text-fg uppercase tracking-wider">
                                      {change.aspect}
                                    </p>
                                    <p className="text-sm text-fg mt-0.5">{change.description}</p>
                                    {change.impact && (
                                      <p className="text-xs text-fg-muted mt-1">
                                        <span className="font-medium">Impact:</span> {change.impact}
                                      </p>
                                    )}
                                    {change.affectedAreas && change.affectedAreas.length > 0 && (
                                      <div className="flex flex-wrap gap-1 mt-1.5">
                                        {change.affectedAreas.map((area) => (
                                          <span key={area} className="badge badge-neutral">
                                            {area}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : (
                        <Alert intent="info">
                          AI-generated diff is unavailable. Set <code>LLM_API_KEY</code> or{' '}
                          <code>ANTHROPIC_API_KEY</code> in <code>.env</code> to enable change
                          summaries. You can still compare versions manually using the timeline.
                        </Alert>
                      )}
                    </SectionShell>
                  )}

                <PlanWorkspaceClient
                  projectId={params.id}
                  selectedPlan={selectedPlan ?? null}
                  previousPlan={previousPlan}
                  memberNames={memberNames}
                  isOwner={isOwner}
                  currentUser={currentUser}
                  nextVersion={nextVersion}
                />
              </div>

              <div className="lg:col-span-5 space-y-6 sticky top-24">
                {selectedPlan && (
                  <>
                    <SectionShell title="Suggestions" className="!p-0">
                      <div className="p-5">
                        <SuggestionPanel
                          projectId={params.id}
                          plan={selectedPlan}
                          suggestions={selectedPlan.suggestions}
                        />
                      </div>
                    </SectionShell>

                    <SectionShell title="Comments" className="!p-0">
                      <div className="p-5">
                        <CommentThread
                          projectId={params.id}
                          planId={selectedPlan.id}
                          comments={selectedPlan.comments}
                        />
                      </div>
                    </SectionShell>
                  </>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </RealtimeWrapper>
  );
}
