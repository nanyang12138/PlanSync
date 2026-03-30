import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { PlanCard } from '@/components/dashboard/plan-card';
import { DriftAlertCard } from '@/components/dashboard/drift-alert-card';
import { TeamGrid } from '@/components/dashboard/team-grid';
import { TaskList } from '@/components/dashboard/task-list';
import { ActivityFeed } from '@/components/dashboard/activity-feed';
import {
  GitBranch,
  ArrowLeft,
  Users,
  AlertTriangle,
  CheckCircle2,
  Activity,
  FileText,
  LayoutDashboard,
  ListChecks,
} from 'lucide-react';
import { RealtimeWrapper } from '@/components/realtime-wrapper';
import { PageHeader } from '@/components/shared/page-header';
import { SummaryStrip } from '@/components/shared/summary-strip';
import { StatusBlock } from '@/components/shared/status-block';
import { SectionShell } from '@/components/shared/section-shell';

export default async function ProjectDashboard({ params }: { params: { id: string } }) {
  const project = await prisma.project.findUnique({
    where: { id: params.id },
    include: {
      members: { orderBy: { createdAt: 'asc' } },
      plans: { orderBy: { version: 'desc' } },
      tasks: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!project) notFound();

  const activePlan = project.plans.find((p) => p.status === 'active');
  const driftAlerts = await prisma.driftAlert.findMany({
    where: { projectId: params.id, status: 'open' },
    include: { task: true },
    orderBy: { createdAt: 'desc' },
  });
  const activities = await prisma.activity.findMany({
    where: { projectId: params.id },
    orderBy: { createdAt: 'desc' },
    take: 15,
  });

  const tasksDone = project.tasks.filter((t) => t.status === 'done').length;
  const tasksTotal = project.tasks.length;
  const progress = tasksTotal > 0 ? Math.round((tasksDone / tasksTotal) * 100) : 0;

  return (
    <RealtimeWrapper projectId={params.id}>
      <div className="page-shell">
        <PageHeader
          breadcrumbs={
            <Link href="/" className="btn-ghost !px-2 !py-1.5">
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
                {project.description && (
                  <p className="text-xs text-slate-500 truncate">{project.description}</p>
                )}
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

        <main className="page-container space-y-6">
          {/* Top Summary Strip */}
          <SummaryStrip
            items={[
              {
                label: 'Active Plan',
                value: activePlan ? `v${activePlan.version}` : 'None',
                icon: <GitBranch className="h-5 w-5" />,
                color: activePlan ? 'blue' : 'slate',
              },
              {
                label: 'Project Health',
                value: driftAlerts.length > 0 ? 'At Risk' : 'Healthy',
                icon:
                  driftAlerts.length > 0 ? (
                    <AlertTriangle className="h-5 w-5" />
                  ) : (
                    <CheckCircle2 className="h-5 w-5" />
                  ),
                color: driftAlerts.length > 0 ? 'amber' : 'emerald',
              },
              {
                label: 'Task Progress',
                value: `${progress}%`,
                icon: <CheckCircle2 className="h-5 w-5" />,
                color: 'emerald',
              },
              {
                label: 'Team Size',
                value: project.members.length,
                icon: <Users className="h-5 w-5" />,
                color: 'violet',
              },
            ]}
          />

          {/* Main grid: 8 + 4 columns */}
          <div className="grid lg:grid-cols-12 gap-6 items-start">
            {/* Left: main panels */}
            <div className="lg:col-span-8 space-y-6">
              {/* Risk-First: Drift Alerts are the highest visual priority in the main column */}
              {driftAlerts.length > 0 ? (
                <SectionShell
                  title="Active Drift Alerts"
                  description={`${driftAlerts.length} task(s) deviated from the active plan`}
                  icon={<AlertTriangle />}
                  className="border-amber-200/60 bg-amber-50/10"
                >
                  <div className="space-y-3">
                    {driftAlerts.map((alert) => (
                      <DriftAlertCard
                        key={alert.id}
                        alert={alert}
                        task={alert.task}
                        projectId={params.id}
                      />
                    ))}
                  </div>
                </SectionShell>
              ) : (
                <StatusBlock
                  type="success"
                  title="Plan Alignment is Perfect"
                  message="All tasks are currently aligned with the active plan. No drifts detected."
                />
              )}

              <SectionShell
                title="Tasks"
                description="Current tasks and their execution status"
                icon={<ListChecks className="h-5 w-5" />}
              >
                <TaskList
                  tasks={project.tasks}
                  activePlanVersion={activePlan?.version}
                  projectId={params.id}
                />
              </SectionShell>
            </div>

            {/* Right sidebar - Sticky */}
            <div className="lg:col-span-4 space-y-6 sticky top-24">
              <SectionShell title="Active Plan" icon={<GitBranch className="h-5 w-5" />}>
                {activePlan ? (
                  <PlanCard plan={activePlan} projectId={params.id} />
                ) : (
                  <p className="text-sm text-slate-500 italic text-center py-4">
                    No active plan yet
                  </p>
                )}
              </SectionShell>

              <SectionShell title="Team Status" icon={<Users className="h-5 w-5" />}>
                <TeamGrid
                  members={project.members}
                  tasks={project.tasks}
                  activePlanVersion={activePlan?.version}
                  driftTaskIds={driftAlerts.map((a) => a.taskId)}
                />
              </SectionShell>

              <SectionShell title="Recent Activity" icon={<Activity className="h-5 w-5" />}>
                <ActivityFeed activities={activities} />
              </SectionShell>
            </div>
          </div>
        </main>
      </div>
    </RealtimeWrapper>
  );
}
