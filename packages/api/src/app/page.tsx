import Link from 'next/link';
import { cookies } from 'next/headers';
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
import { PageHeader } from '@/components/shared/page-header';
import { SummaryStrip } from '@/components/shared/summary-strip';

async function getHomeProjects(currentUser: string) {
  return prisma.project.findMany({
    where: currentUser !== 'anonymous' ? { members: { some: { name: currentUser } } } : undefined,
    include: {
      _count: { select: { members: true, plans: true, tasks: true, driftAlerts: true } },
      plans: { where: { status: 'active' }, take: 1 },
      driftAlerts: { where: { status: 'open' } },
      activities: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
    orderBy: { updatedAt: 'desc' },
  });
}

type HomeProject = Awaited<ReturnType<typeof getHomeProjects>>[number];

export default async function HomePage() {
  const currentUser = cookies().get('plansync-user')?.value ?? 'anonymous';
  const projects = await getHomeProjects(currentUser);

  const totalProjects = projects.length;
  const totalOpenDrifts = projects.reduce((s, p) => s + p.driftAlerts.length, 0);
  const totalTasks = projects.reduce((s, p) => s + p._count.tasks, 0);

  // Group projects by risk status
  const projectsWithDrifts = projects.filter((p) => p.driftAlerts.length > 0);
  const healthyProjects = projects.filter((p) => p.driftAlerts.length === 0);

  return (
    <div className="page-shell">
      <PageHeader
        title={
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 shadow-md shadow-blue-600/20">
              <GitBranch className="h-4.5 w-4.5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-slate-900 leading-none">PlanSync</h1>
              <p className="text-xs text-slate-500 mt-0.5">AI Team Coordination</p>
            </div>
          </div>
        }
      />

      <main className="page-container space-y-8">
        {/* Top Summary Strip */}
        <SummaryStrip
          items={[
            {
              label: 'Total Projects',
              value: totalProjects,
              icon: <Layers className="h-5 w-5" />,
              color: 'blue',
            },
            {
              label: 'Active Tasks',
              value: totalTasks,
              icon: <ListChecks className="h-5 w-5" />,
              color: 'emerald',
            },
            {
              label: 'Open Drifts',
              value: totalOpenDrifts,
              icon: <AlertTriangle className="h-5 w-5" />,
              color: totalOpenDrifts > 0 ? 'amber' : 'slate',
            },
          ]}
        />

        {projects.length === 0 ? (
          <div className="panel p-16 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100">
              <Zap className="h-7 w-7 text-slate-400" />
            </div>
            <p className="text-base font-semibold text-slate-700">No projects yet</p>
            <p className="text-sm text-slate-500 mt-1.5">
              Create one via the API or CLI to get started
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {/* Attention Needed Section */}
            {projectsWithDrifts.length > 0 && (
              <section>
                <div className="mb-4 flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                  <h2 className="text-lg font-bold text-slate-900">Attention Needed</h2>
                  <span className="badge badge-warning ml-2">{projectsWithDrifts.length}</span>
                </div>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {projectsWithDrifts.map((project) => (
                    <ProjectCard key={project.id} project={project} isAtRisk={true} />
                  ))}
                </div>
              </section>
            )}

            {/* Healthy Projects Section */}
            {healthyProjects.length > 0 && (
              <section>
                <div className="mb-4 flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  <h2 className="text-lg font-bold text-slate-900">Healthy Projects</h2>
                  <span className="badge badge-neutral ml-2">{healthyProjects.length}</span>
                </div>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {healthyProjects.map((project) => (
                    <ProjectCard key={project.id} project={project} isAtRisk={false} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// Extracted ProjectCard component for reuse
function ProjectCard({ project, isAtRisk }: { project: HomeProject; isAtRisk: boolean }) {
  const activePlan = project.plans[0];
  const openDrifts = project.driftAlerts.length;
  const lastActivity = project.activities[0];

  return (
    <Link
      href={`/projects/${project.id}`}
      className={`group panel p-5 transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5 flex flex-col h-full ${
        isAtRisk
          ? 'border-amber-200/60 bg-amber-50/10 hover:border-amber-300 hover:shadow-amber-500/5'
          : 'hover:border-blue-200 hover:shadow-blue-500/5'
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-900 group-hover:text-blue-600 transition-colors truncate">
            {project.name}
          </h3>
          {project.description && (
            <p className="text-sm text-slate-500 line-clamp-1 mt-1">{project.description}</p>
          )}
        </div>
        <ArrowUpRight className="h-4 w-4 text-slate-300 group-hover:text-blue-500 transition-colors shrink-0 mt-0.5" />
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4 mt-auto">
        {activePlan ? (
          <>
            <span className="badge badge-brand font-mono">v{activePlan.version}</span>
            <span className="text-xs text-slate-500 truncate max-w-[150px]">
              {activePlan.title}
            </span>
          </>
        ) : (
          <span className="text-xs text-slate-400 italic">No active plan</span>
        )}

        {openDrifts > 0 && (
          <span className="badge badge-warning ml-auto">
            <AlertTriangle className="h-3 w-3 mr-1" />
            {openDrifts} drift{openDrifts > 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div className="flex gap-4 text-xs text-slate-500 pt-4 border-t border-slate-100">
        <span className="flex items-center gap-1.5" title="Members">
          <Users className="h-4 w-4 text-slate-400" />
          {project._count.members}
        </span>
        <span className="flex items-center gap-1.5" title="Plans">
          <GitBranch className="h-4 w-4 text-slate-400" />
          {project._count.plans}
        </span>
        <span className="flex items-center gap-1.5" title="Tasks">
          <CheckCircle2 className="h-4 w-4 text-slate-400" />
          {project._count.tasks}
        </span>
        {lastActivity && (
          <span className="ml-auto text-xs text-slate-400 truncate max-w-[120px]">
            {lastActivity.type.replace(/_/g, ' ')}
          </span>
        )}
      </div>
    </Link>
  );
}
