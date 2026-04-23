import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { DriftAlertCard } from '@/components/dashboard/drift-alert-card';
import { TaskViewToggle } from '@/components/dashboard/task-view-toggle';
import { NewTaskButton } from '@/components/dashboard/new-task-button';
import { SidebarTabs } from '@/components/dashboard/sidebar-tabs';
import { GitBranch, Users, AlertTriangle, ListChecks } from 'lucide-react';
import { RealtimeWrapper } from '@/components/realtime-wrapper';
import { PageHeader } from '@/components/shared/page-header';
import { DeleteProjectButton } from '@/components/shared/delete-project-button';
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
  const currentUser = cookies().get('plansync-user')?.value ?? 'anonymous';
  const isOwner = project.members.some((m) => m.name === currentUser && m.role === 'owner');
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

  return (
    <RealtimeWrapper projectId={params.id}>
      <div className="page-shell">
        <PageHeader
          title={
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-blue-600 to-violet-600 shrink-0">
                <GitBranch className="h-3.5 w-3.5 text-white" />
              </div>
              <div className="min-w-0">
                <h1 className="text-sm font-bold text-slate-900 truncate leading-tight">
                  {project.name}
                </h1>
                {project.description && (
                  <p className="text-xs text-slate-400 truncate">{project.description}</p>
                )}
              </div>
            </div>
          }
          navigation={[]}
          actions={<DeleteProjectButton projectId={params.id} projectName={project.name} />}
        />

        <main className="page-container space-y-6">
          {/* Top Summary Strip */}
          <div className="grid grid-cols-3 gap-4">
            {/* Active Plan */}
            <Link
              href={`/projects/${params.id}/plans`}
              className="panel p-4 flex items-center gap-3 hover:shadow-md hover:-translate-y-0.5 transition-all"
              title="View and manage plans"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50">
                <GitBranch className="h-5 w-5 text-blue-500" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-slate-400 mb-1">Active Plan</p>
                <p className="text-xl font-bold text-blue-700 leading-none">
                  {activePlan ? `v${activePlan.version}` : 'None'}
                </p>
                {activePlan?.title && (
                  <p className="text-[11px] text-slate-400 truncate mt-0.5">{activePlan.title}</p>
                )}
              </div>
            </Link>

            {/* Task Progress */}
            <div className="panel p-4 flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50">
                <ListChecks className="h-5 w-5 text-emerald-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-slate-400 mb-1">Task Progress</p>
                <p className="text-xl font-bold text-slate-800 leading-none tabular-nums">
                  {tasksDone} / {tasksTotal}
                </p>
                {tasksTotal > 0 && (
                  <div className="mt-1.5 h-1 w-full rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-all"
                      style={{ width: `${Math.round((tasksDone / tasksTotal) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Team Members */}
            <Link
              href={`/projects/${params.id}/members`}
              className="panel p-4 flex items-center gap-3 hover:shadow-md hover:-translate-y-0.5 transition-all"
              title="View, add or remove team members"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-50">
                <Users className="h-5 w-5 text-violet-500" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-slate-400 mb-1.5">Team Members</p>
                <div className="flex items-center gap-1 flex-wrap">
                  {project.members.slice(0, 5).map((m) => (
                    <span
                      key={m.name}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-violet-100 text-[10px] font-bold text-violet-700"
                      title={`${m.name} (${m.role})`}
                    >
                      {m.name[0].toUpperCase()}
                    </span>
                  ))}
                  {project.members.length > 5 && (
                    <span className="text-xs text-slate-400">+{project.members.length - 5}</span>
                  )}
                  {project.members.length === 0 && (
                    <span className="text-xs text-slate-300 italic">No members</span>
                  )}
                </div>
              </div>
            </Link>
          </div>

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
                        isOwner={isOwner}
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
                action={
                  <NewTaskButton
                    projectId={params.id}
                    memberNames={project.members.map((m) => m.name)}
                    disabled={!activePlan}
                    disabledReason="Activate a plan first to add tasks"
                  />
                }
              >
                <div className="max-h-[600px] overflow-y-auto">
                  <TaskViewToggle
                    tasks={project.tasks}
                    activePlanVersion={activePlan?.version}
                    projectId={params.id}
                  />
                </div>
              </SectionShell>
            </div>

            {/* Right sidebar - Sticky */}
            <div className="lg:col-span-4 sticky top-24">
              <SidebarTabs projectId={params.id} activities={activities} />
            </div>
          </div>
        </main>
      </div>
    </RealtimeWrapper>
  );
}
