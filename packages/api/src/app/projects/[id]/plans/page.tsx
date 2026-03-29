import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { notFound } from 'next/navigation';
import { PlanTimeline } from '@/components/plan/plan-timeline';
import { PlanDetail } from '@/components/plan/plan-detail';
import { SuggestionPanel } from '@/components/plan/suggestion-panel';
import { CommentThread } from '@/components/plan/comment-thread';
import { ArrowLeft, GitBranch, Clock } from 'lucide-react';
import { RealtimeWrapper } from '@/components/realtime-wrapper';

export default async function ProjectPlansPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { plan?: string };
}) {
  const project = await prisma.project.findUnique({
    where: { id: params.id },
    select: { id: true, name: true },
  });
  if (!project) notFound();

  const plans = await prisma.plan.findMany({
    where: { projectId: params.id },
    include: {
      reviews: true,
      suggestions: { orderBy: { createdAt: 'desc' } },
      comments: { orderBy: { createdAt: 'asc' } },
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

  return (
    <RealtimeWrapper projectId={params.id}>
      <div className="page-shell">
        <header className="page-header">
          <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-3">
            <Link href={`/projects/${params.id}`} className="btn-ghost !px-2 !py-1.5">
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Back</span>
            </Link>
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 shadow-sm shrink-0">
                <GitBranch className="h-3.5 w-3.5 text-white" />
              </div>
              <h1 className="text-base font-bold text-slate-900 truncate">{project.name}</h1>
              <span className="badge badge-neutral">Plans</span>
            </div>
          </div>
        </header>

        <main className="page-container">
          {plans.length === 0 ? (
            <div className="panel p-16 text-center">
              <p className="text-sm text-slate-400">No plans yet for this project.</p>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="panel p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-slate-400" />
                    <span className="section-label">Version Timeline</span>
                  </div>
                  <span className="text-xs text-slate-400">{plans.length} versions</span>
                </div>
                <PlanTimeline
                  projectId={params.id}
                  plans={timelinePlans}
                  selectedPlanId={selectedPlanId ?? ''}
                />
              </div>

              {selectedPlan && (
                <div className="grid lg:grid-cols-12 gap-6">
                  <div className="lg:col-span-7">
                    <PlanDetail plan={selectedPlan} previousPlan={previousPlan} />
                  </div>
                  <div className="lg:col-span-5 space-y-6">
                    <SuggestionPanel
                      projectId={params.id}
                      plan={selectedPlan}
                      suggestions={selectedPlan.suggestions}
                    />
                    <CommentThread
                      projectId={params.id}
                      planId={selectedPlan.id}
                      comments={selectedPlan.comments}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </RealtimeWrapper>
  );
}
