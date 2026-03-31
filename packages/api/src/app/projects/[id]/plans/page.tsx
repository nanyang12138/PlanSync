import Link from 'next/link';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { notFound } from 'next/navigation';
import { PlanTimeline } from '@/components/plan/plan-timeline';
import { PlanWorkspaceClient } from '@/components/plan/plan-workspace-client';
import { SuggestionPanel } from '@/components/plan/suggestion-panel';
import { CommentThread } from '@/components/plan/comment-thread';
import { ArrowLeft, GitBranch, FileText, Users, LayoutDashboard, History } from 'lucide-react';
import { RealtimeWrapper } from '@/components/realtime-wrapper';
import { PageHeader } from '@/components/shared/page-header';
import { SectionShell } from '@/components/shared/section-shell';

export default async function ProjectPlansPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { plan?: string };
}) {
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
  const currentUser = cookies().get('plansync-user')?.value ?? 'anonymous';
  const currentMember = project.members.find((member) => member.name === currentUser);
  const isOwner = currentMember?.role === 'owner';
  const memberNames = project.members.map((member) => member.name);
  const nextVersion = (plans[0]?.version ?? 0) + 1;

  // Helper function to generate mock diff summary since we don't have real diff data in schema
  const getMockDiffSummary = (currentVersion: number) => {
    if (currentVersion === 1) return null;

    // Deterministic mock data based on version number
    const diffs = [
      { type: 'added', text: 'Added 2 new constraints regarding API rate limits' },
      { type: 'modified', text: 'Updated the primary goal to include mobile responsiveness' },
      { type: 'removed', text: 'Removed deprecated authentication requirements' },
      { type: 'impact', text: '3 tasks may need to be updated due to constraint changes' },
    ];

    // Pick 2-3 diffs based on version to make it look dynamic
    return diffs.filter((_, i) => (currentVersion + i) % 2 === 0 || i === 3);
  };

  const diffSummary = selectedPlan ? getMockDiffSummary(selectedPlan.version) : null;

  return (
    <RealtimeWrapper projectId={params.id}>
      <div className="page-shell">
        <PageHeader
          breadcrumbs={
            <Link href={`/projects/${params.id}`} className="btn-ghost !px-2 !py-1.5">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          }
          title={
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 shadow-sm shrink-0">
                <GitBranch className="h-3.5 w-3.5 text-white" />
              </div>
              <div className="min-w-0">
                <h1 className="text-base font-bold text-slate-900 truncate leading-tight">
                  {project.name}
                </h1>
              </div>
            </div>
          }
          navigation={[
            {
              label: 'Dashboard',
              href: `/projects/${params.id}`,
              icon: <LayoutDashboard className="h-4 w-4" />,
            },
            {
              label: 'Plans',
              href: `/projects/${params.id}/plans`,
              icon: <FileText className="h-4 w-4" />,
            },
            {
              label: 'Members',
              href: `/projects/${params.id}/members`,
              icon: <Users className="h-4 w-4" />,
            },
          ]}
        />

        <main className="page-container">
          <div className="space-y-6">
            <SectionShell
              title="Version History"
              icon={<History className="h-5 w-5" />}
              action={<span className="text-sm text-slate-500">{plans.length} versions</span>}
            >
              {plans.length > 0 ? (
                <PlanTimeline
                  projectId={params.id}
                  plans={timelinePlans}
                  selectedPlanId={selectedPlanId ?? ''}
                />
              ) : (
                <div className="py-6 text-center">
                  <p className="text-base font-semibold text-slate-700">No plans yet</p>
                  <p className="mt-1 text-sm text-slate-500">
                    Owners can create the first draft plan from this page.
                  </p>
                </div>
              )}
            </SectionShell>

            <div className="grid lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-7 space-y-6">
                {selectedPlan && diffSummary && diffSummary.length > 0 && (
                  <SectionShell
                    title={`Changes in v${selectedPlan.version}`}
                    description={`Compared to v${selectedPlan.version - 1}`}
                    icon={<GitBranch className="h-5 w-5" />}
                    className="border-blue-200/60 bg-blue-50/10"
                  >
                    <div className="space-y-3">
                      {diffSummary.map((diff, i) => (
                        <div key={i} className="flex items-start gap-3">
                          <div className="mt-0.5 shrink-0">
                            {diff.type === 'added' && (
                              <div className="h-4 w-4 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center text-[10px] font-bold">
                                +
                              </div>
                            )}
                            {diff.type === 'modified' && (
                              <div className="h-4 w-4 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-[10px] font-bold">
                                ~
                              </div>
                            )}
                            {diff.type === 'removed' && (
                              <div className="h-4 w-4 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center text-[10px] font-bold">
                                -
                              </div>
                            )}
                            {diff.type === 'impact' && (
                              <div className="h-4 w-4 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-[10px] font-bold">
                                !
                              </div>
                            )}
                          </div>
                          <p
                            className={`text-sm ${diff.type === 'impact' ? 'text-amber-700 font-medium' : 'text-slate-700'}`}
                          >
                            {diff.text}
                          </p>
                        </div>
                      ))}
                    </div>
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
