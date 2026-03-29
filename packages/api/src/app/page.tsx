import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import {
  GitBranch,
  Users,
  CheckCircle2,
  AlertTriangle,
  Zap,
  ArrowUpRight,
  Layers,
  ListChecks,
} from 'lucide-react';
import { UserIdentity } from '@/components/user-identity';

export default async function HomePage() {
  const projects = await prisma.project.findMany({
    include: {
      _count: { select: { members: true, plans: true, tasks: true, driftAlerts: true } },
      plans: { where: { status: 'active' }, take: 1 },
      driftAlerts: { where: { status: 'open' } },
      activities: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const totalProjects = projects.length;
  const totalOpenDrifts = projects.reduce((s, p) => s + p.driftAlerts.length, 0);
  const totalTasks = projects.reduce((s, p) => s + p._count.tasks, 0);

  return (
    <div className="page-shell">
      <header className="page-header">
        <div className="mx-auto max-w-7xl px-6 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 shadow-md shadow-blue-600/20">
              <GitBranch className="h-4.5 w-4.5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 leading-none">PlanSync</h1>
              <p className="text-[11px] text-slate-400 mt-0.5">AI Team Coordination</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
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

      <main className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Projects</h2>
          <p className="mt-1.5 text-sm text-slate-500">Select a project to view its dashboard</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          {[
            { icon: Layers, label: 'Projects', value: totalProjects, color: 'blue' },
            { icon: ListChecks, label: 'Tasks', value: totalTasks, color: 'emerald' },
            { icon: AlertTriangle, label: 'Open Drifts', value: totalOpenDrifts, color: 'amber' },
          ].map(({ icon: Icon, label, value, color }) => (
            <div key={label} className="panel p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="section-label mb-1">{label}</p>
                  <p className="text-2xl font-bold text-slate-900 tabular-nums">{value}</p>
                </div>
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-xl bg-${color}-50`}
                >
                  <Icon className={`h-5 w-5 text-${color}-500`} />
                </div>
              </div>
            </div>
          ))}
        </div>

        {projects.length === 0 ? (
          <div className="panel p-16 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100">
              <Zap className="h-7 w-7 text-slate-400" />
            </div>
            <p className="text-base font-semibold text-slate-700">No projects yet</p>
            <p className="text-sm text-slate-400 mt-1.5">
              Create one via the API or CLI to get started
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => {
              const activePlan = project.plans[0];
              const openDrifts = project.driftAlerts.length;
              const lastActivity = project.activities[0];

              return (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className="group panel p-5 transition-all duration-200 hover:border-blue-200 hover:shadow-lg hover:shadow-blue-500/5 hover:-translate-y-0.5"
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-slate-900 group-hover:text-blue-600 transition-colors truncate">
                        {project.name}
                      </h3>
                      {project.description && (
                        <p className="text-xs text-slate-500 line-clamp-1 mt-0.5 leading-relaxed">
                          {project.description}
                        </p>
                      )}
                    </div>
                    <ArrowUpRight className="h-4 w-4 text-slate-300 group-hover:text-blue-500 transition-colors shrink-0 mt-0.5" />
                  </div>

                  {(activePlan || openDrifts > 0) && (
                    <div className="flex flex-wrap items-center gap-2 mb-3">
                      {activePlan && (
                        <span className="badge badge-brand font-mono">v{activePlan.version}</span>
                      )}
                      {activePlan && (
                        <span className="text-xs text-slate-400 truncate">{activePlan.title}</span>
                      )}
                      {openDrifts > 0 && (
                        <span className="badge badge-warning ml-auto">
                          <AlertTriangle className="h-3 w-3 mr-0.5" />
                          {openDrifts} drift{openDrifts > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  )}

                  <div className="flex gap-4 text-xs text-slate-400 pt-3 border-t border-slate-100">
                    <span className="flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5" />
                      {project._count.members}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <GitBranch className="h-3.5 w-3.5" />
                      {project._count.plans}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {project._count.tasks}
                    </span>
                    {lastActivity && (
                      <span className="ml-auto text-[11px] text-slate-300 truncate max-w-[120px]">
                        {lastActivity.type.replace(/_/g, ' ')}
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
