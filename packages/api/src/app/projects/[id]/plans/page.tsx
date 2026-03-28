import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { notFound } from 'next/navigation';
import { PlanTimeline } from '@/components/plan/plan-timeline';
import { PlanDetail } from '@/components/plan/plan-detail';
import { SuggestionPanel } from '@/components/plan/suggestion-panel';
import { CommentThread } from '@/components/plan/comment-thread';
import { ArrowLeft, GitBranch } from 'lucide-react';
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
      <div className="min-h-screen bg-background">
        <header className="border-b bg-card">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-6 py-4">
            <Link
              href={`/projects/${params.id}`}
              className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to project
            </Link>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <GitBranch className="h-5 w-5 shrink-0 text-primary" />
              <h1 className="text-xl font-bold">{project.name}</h1>
              <span className="text-sm text-muted-foreground">Plans</span>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl space-y-8 px-6 py-6">
          {plans.length === 0 ? (
            <p className="text-sm text-muted-foreground">No plans yet for this project.</p>
          ) : (
            <>
              <section aria-label="Plan versions">
                <h2 className="mb-4 text-lg font-semibold">Version timeline</h2>
                <PlanTimeline
                  projectId={params.id}
                  plans={timelinePlans}
                  selectedPlanId={selectedPlanId ?? ''}
                />
              </section>

              {selectedPlan && (
                <>
                  <PlanDetail plan={selectedPlan} previousPlan={previousPlan} />

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
                </>
              )}
            </>
          )}
        </main>
      </div>
    </RealtimeWrapper>
  );
}
