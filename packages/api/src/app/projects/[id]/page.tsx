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
  Clock,
  Activity,
  FileText,
} from 'lucide-react';
import { RealtimeWrapper } from '@/components/realtime-wrapper';
import { UserIdentity } from '@/components/user-identity';

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

  return (
    <RealtimeWrapper projectId={params.id}>
      <div className="page-shell">
        <header className="page-header">
          <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-3">
            <Link href="/" className="btn-ghost !px-2 !py-1.5">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 shadow-sm shrink-0">
                <GitBranch className="h-3.5 w-3.5 text-white" />
              </div>
              <div className="min-w-0">
                <h1 className="text-base font-bold text-slate-900 truncate leading-tight">
                  {project.name}
                </h1>
                {project.description && (
                  <p className="text-[11px] text-slate-400 truncate">{project.description}</p>
                )}
              </div>
            </div>
            <nav className="hidden md:flex items-center gap-1">
              <Link href={`/projects/${params.id}/plans`} className="btn-ghost">
                <FileText className="h-3.5 w-3.5" /> Plans
              </Link>
              <Link href={`/projects/${params.id}/members`} className="btn-ghost">
                <Users className="h-3.5 w-3.5" /> Members
              </Link>
            </nav>
            <div className="flex items-center gap-3">
              <UserIdentity />
              <div className="flex items-center gap-1.5 text-xs text-emerald-600 font-medium bg-emerald-50 rounded-full px-2.5 py-1">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                </span>
                Live
              </div>
            </div>
          </div>
        </header>

        <main className="page-container">
          {/* Plan version timeline strip */}
          {project.plans.length > 0 && (
            <div className="panel mb-6 px-5 py-3">
              <div className="flex items-center gap-2 mb-2.5">
                <Clock className="h-3.5 w-3.5 text-slate-400" />
                <span className="section-label">Plan Timeline</span>
              </div>
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                {[...project.plans].reverse().map((p, i) => (
                  <div key={p.id} className="flex items-center gap-2 flex-shrink-0">
                    <Link
                      href={`/projects/${params.id}/plans?plan=${p.id}`}
                      className={`flex flex-col items-center gap-1 px-3 py-2 rounded-lg border transition-all hover:border-blue-300 hover:shadow-sm ${
                        p.status === 'active'
                          ? 'border-blue-200 bg-blue-50/80'
                          : p.status === 'draft'
                            ? 'border-violet-200 bg-violet-50/50'
                            : p.status === 'proposed'
                              ? 'border-amber-200 bg-amber-50/50'
                              : 'border-slate-200 bg-white'
                      }`}
                    >
                      <span
                        className={`text-xs font-bold font-mono ${
                          p.status === 'active'
                            ? 'text-blue-600'
                            : p.status === 'draft'
                              ? 'text-violet-500'
                              : p.status === 'proposed'
                                ? 'text-amber-600'
                                : 'text-slate-400'
                        }`}
                      >
                        v{p.version}
                      </span>
                      <span
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                          p.status === 'active'
                            ? 'bg-blue-100 text-blue-700'
                            : p.status === 'draft'
                              ? 'bg-violet-100 text-violet-600'
                              : p.status === 'proposed'
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-slate-100 text-slate-400'
                        }`}
                      >
                        {p.status}
                      </span>
                    </Link>
                    {i < project.plans.length - 1 && (
                      <svg
                        className="h-3.5 w-3.5 text-slate-300 flex-shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Main grid: 8 + 4 columns */}
          <div className="grid lg:grid-cols-12 gap-6">
            {/* Left: main panels */}
            <div className="lg:col-span-8 space-y-6">
              {/* Active Plan + Drift Alerts row */}
              <div className="grid sm:grid-cols-2 gap-4">
                {activePlan ? (
                  <PlanCard plan={activePlan} projectId={params.id} />
                ) : (
                  <div className="panel p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <GitBranch className="h-4 w-4 text-slate-400" />
                      <span className="section-label">Active Plan</span>
                    </div>
                    <p className="text-sm text-slate-400 italic">No active plan yet</p>
                  </div>
                )}

                <div
                  className={`panel p-5 transition-colors ${
                    driftAlerts.length > 0 ? 'border-amber-200 bg-amber-50/30' : ''
                  }`}
                >
                  <div className="flex items-center gap-2 mb-3">
                    {driftAlerts.length > 0 ? (
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    )}
                    <span
                      className={`section-label ${
                        driftAlerts.length > 0 ? '!text-amber-600' : '!text-emerald-500'
                      }`}
                    >
                      Drift Alerts
                    </span>
                    {driftAlerts.length > 0 && (
                      <span className="ml-auto badge badge-warning text-[10px]">
                        {driftAlerts.length}
                      </span>
                    )}
                  </div>

                  {driftAlerts.length === 0 ? (
                    <p className="text-sm text-slate-400">All tasks aligned with active plan.</p>
                  ) : (
                    <div className="space-y-2.5">
                      {driftAlerts.map((alert) => (
                        <DriftAlertCard
                          key={alert.id}
                          alert={alert}
                          task={alert.task}
                          projectId={params.id}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <TaskList
                tasks={project.tasks}
                activePlanVersion={activePlan?.version}
                projectId={params.id}
              />
            </div>

            {/* Right sidebar */}
            <div className="lg:col-span-4 space-y-6">
              {/* Quick stats */}
              <div className="grid grid-cols-2 gap-3">
                <div className="panel p-4 text-center">
                  <p className="text-xl font-bold text-slate-900 tabular-nums">
                    {tasksDone}
                    <span className="text-slate-300">/{tasksTotal}</span>
                  </p>
                  <p className="text-[11px] text-slate-400 font-medium uppercase tracking-wider mt-0.5">
                    Tasks Done
                  </p>
                </div>
                <div className="panel p-4 text-center">
                  <p className="text-xl font-bold text-slate-900 tabular-nums">
                    {project.members.length}
                  </p>
                  <p className="text-[11px] text-slate-400 font-medium uppercase tracking-wider mt-0.5">
                    Members
                  </p>
                </div>
              </div>

              <TeamGrid
                members={project.members}
                tasks={project.tasks}
                activePlanVersion={activePlan?.version}
                driftTaskIds={driftAlerts.map((a) => a.taskId)}
              />

              <div className="panel p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Activity className="h-4 w-4 text-slate-400" />
                  <span className="section-label">Recent Activity</span>
                </div>
                <ActivityFeed activities={activities} />
              </div>
            </div>
          </div>
        </main>
      </div>
    </RealtimeWrapper>
  );
}
