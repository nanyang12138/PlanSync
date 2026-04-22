import Link from 'next/link';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { GitBranch, AlertTriangle, ArrowRight, Layers, ListChecks, Users, Zap } from 'lucide-react';
import { NewProjectButton } from '@/components/shared/new-project-button';
import { DeleteProjectButton } from '@/components/shared/delete-project-button';
import { UserIdentity } from '@/components/user-identity';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(diff / 3_600_000);
  const d = Math.floor(diff / 86_400_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 30) return `${d}d ago`;
  return date.toLocaleDateString();
}

// ─── Data ─────────────────────────────────────────────────────────────────────

async function getHomeProjects(currentUser: string) {
  return prisma.project.findMany({
    where: currentUser !== 'anonymous' ? { members: { some: { name: currentUser } } } : undefined,
    include: {
      _count: { select: { members: true, tasks: true } },
      plans: {
        where: { status: 'active' },
        take: 1,
        select: { id: true, version: true, title: true },
      },
      tasks: { where: { status: 'done' }, select: { id: true } },
      driftAlerts: { where: { status: 'open' }, select: { id: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });
}

type HomeProject = Awaited<ReturnType<typeof getHomeProjects>>[number];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function HomePage() {
  const currentUser = cookies().get('plansync-user')?.value ?? 'anonymous';
  const projects = await getHomeProjects(currentUser);

  const totalProjects = projects.length;
  const totalOpenDrifts = projects.reduce((s, p) => s + p.driftAlerts.length, 0);
  const totalTasks = projects.reduce((s, p) => s + p._count.tasks, 0);

  return (
    <div className="min-h-screen bg-[#f8f9fb]">
      {/* ── Top navigation bar ─────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 h-16 gap-4">
          {/* Logo */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 shadow-sm">
              <GitBranch className="h-5 w-5 text-white" />
            </div>
            <span className="font-bold text-slate-900 text-base tracking-tight">PlanSync</span>
            <span className="hidden sm:inline text-slate-300 select-none text-sm">·</span>
            <span className="hidden sm:inline text-sm text-slate-400">
              Where Plans Meet Execution
            </span>
          </div>

          {/* Right: identity + action */}
          <div className="flex items-center gap-3">
            {/* Live badge */}
            <div className="hidden sm:flex items-center gap-1.5 text-xs text-emerald-600 font-medium bg-emerald-50 rounded-full px-2.5 py-1 border border-emerald-100">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
              </span>
              Live
            </div>
            <UserIdentity />
            <NewProjectButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-7 space-y-6">
        {/* ── Overview stat strip ─────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-3">
          <StatCard
            label="Projects"
            value={totalProjects}
            icon={<Layers className="h-4 w-4" />}
            color="blue"
          />
          <StatCard
            label="Total Tasks"
            value={totalTasks}
            icon={<ListChecks className="h-4 w-4" />}
            color="slate"
          />
          <StatCard
            label="Open Drifts"
            value={totalOpenDrifts}
            icon={<AlertTriangle className="h-4 w-4" />}
            color={totalOpenDrifts > 0 ? 'amber' : 'slate'}
            hint={
              totalOpenDrifts > 0
                ? 'Tasks deviated from plan — action needed'
                : 'All tasks aligned with plans'
            }
          />
        </div>

        {/* ── Project list ─────────────────────────────────────────────── */}
        {projects.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="panel overflow-hidden">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/70">
                  <th className="w-8 px-5 py-2.5" />
                  <th className="px-2 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Project / Plan
                  </th>
                  <th className="w-32 px-2 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Progress
                  </th>
                  <th className="w-14 px-2 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Team
                  </th>
                  <th className="w-20 px-2 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Updated
                  </th>
                  <th className="w-40 px-5 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {projects.map((p) => (
                  <ProjectRow key={p.id} project={p} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Hint footer ──────────────────────────────────────────────── */}
        {projects.length > 0 && (
          <p className="text-center text-xs text-slate-400">
            Hover a row to reveal delete · Click a project name or <strong>Open</strong> to enter
            the dashboard
          </p>
        )}
      </main>
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon,
  color,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  icon: React.ReactNode;
  color: 'blue' | 'emerald' | 'amber' | 'slate';
  hint?: string;
}) {
  const colors = {
    blue: 'bg-blue-50 text-blue-600 border-blue-100',
    emerald: 'bg-emerald-50 text-emerald-600 border-emerald-100',
    amber: 'bg-amber-50 text-amber-600 border-amber-100',
    slate: 'bg-slate-50 text-slate-400 border-slate-100',
  };
  const valueColors = {
    blue: 'text-blue-700',
    emerald: 'text-emerald-700',
    amber: 'text-amber-700',
    slate: 'text-slate-700',
  };
  return (
    <div className="panel px-4 py-3 flex items-center gap-3 cursor-default" title={hint}>
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${colors[color]}`}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-slate-400 leading-none mb-1">{label}</p>
        <p className={`text-lg font-bold tabular-nums leading-none ${valueColors[color]}`}>
          {value}
        </p>
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="panel p-16 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50">
        <Zap className="h-7 w-7 text-blue-400" />
      </div>
      <p className="text-base font-semibold text-slate-700">No projects yet</p>
      <p className="text-sm text-slate-400 mt-1.5 mb-6 max-w-xs mx-auto">
        Create a project to start tracking plans, tasks, and team alignment
      </p>
      <NewProjectButton />
    </div>
  );
}

// ─── Project row ──────────────────────────────────────────────────────────────

function ProjectRow({ project }: { project: HomeProject }) {
  const activePlan = project.plans[0];
  const openDrifts = project.driftAlerts.length;
  const tasksDone = project.tasks.length;
  const tasksTotal = project._count.tasks;
  const progress = tasksTotal > 0 ? Math.round((tasksDone / tasksTotal) * 100) : 0;
  const isAtRisk = openDrifts > 0;

  const progressColor =
    progress === 100 ? 'bg-emerald-500' : isAtRisk ? 'bg-amber-400' : 'bg-blue-500';

  return (
    <tr className="group hover:bg-blue-50/30 transition-colors">
      {/* ① Status dot */}
      <td
        className="px-5 py-4"
        title={
          isAtRisk
            ? `${openDrifts} drift alert${openDrifts > 1 ? 's' : ''} — action needed`
            : 'Healthy — no drift alerts'
        }
      >
        {isAtRisk ? (
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-50" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400" />
          </span>
        ) : (
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
        )}
      </td>

      {/* ② Name + plan info */}
      <td className="px-2 py-4 max-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            href={`/projects/${project.id}`}
            className="font-semibold text-sm text-slate-900 hover:text-blue-600 transition-colors"
          >
            {project.name}
          </Link>
          {activePlan ? (
            <span
              className="badge badge-brand font-mono text-[11px]"
              title={`Active plan: v${activePlan.version} — ${activePlan.title || 'untitled'}`}
            >
              v{activePlan.version}
            </span>
          ) : null}
          {isAtRisk && (
            <span
              className="badge badge-warning text-[11px]"
              title={`${openDrifts} task${openDrifts > 1 ? 's have' : ' has'} deviated from the plan`}
            >
              <AlertTriangle className="h-3 w-3 mr-0.5" />
              {openDrifts} drift{openDrifts > 1 ? 's' : ''}
            </span>
          )}
        </div>
        {activePlan?.title ? (
          <p className="text-[11px] text-slate-400 mt-0.5 truncate" title={activePlan.title}>
            {activePlan.title}
          </p>
        ) : (
          <p className="text-[11px] text-slate-300 mt-0.5 italic">No active plan</p>
        )}
      </td>

      {/* ③ Progress bar */}
      <td
        className="px-2 py-4"
        title={
          tasksTotal === 0
            ? 'No tasks yet'
            : `${tasksDone} of ${tasksTotal} tasks done (${progress}%)`
        }
      >
        {tasksTotal > 0 ? (
          <div className="space-y-1">
            <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${progressColor}`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-slate-400 tabular-nums">
              <span>
                {tasksDone}/{tasksTotal}
              </span>
              <span>{progress}%</span>
            </div>
          </div>
        ) : (
          <span className="block text-[11px] text-slate-400 text-center">no tasks</span>
        )}
      </td>

      {/* ④ Team size */}
      <td
        className="px-2 py-4 text-center"
        title={`${project._count.members} member${project._count.members !== 1 ? 's' : ''}`}
      >
        <span className="inline-flex items-center justify-center gap-1 text-xs text-slate-400">
          <Users className="h-3.5 w-3.5 text-slate-300" />
          {project._count.members}
        </span>
      </td>

      {/* ⑤ Last updated */}
      <td
        className="px-2 py-4 text-right text-[11px] text-slate-400 tabular-nums"
        title={project.updatedAt.toLocaleString()}
      >
        {formatRelativeTime(project.updatedAt)}
      </td>

      {/* ⑥ Actions */}
      <td className="px-5 py-4">
        <div className="flex items-center justify-center gap-1.5">
          <Link
            href={`/projects/${project.id}`}
            className="btn-primary !px-3 !py-1.5 text-xs gap-1"
            title="Open project dashboard"
          >
            Open
            <ArrowRight className="h-3 w-3" />
          </Link>
          <DeleteProjectButton projectId={project.id} projectName={project.name} />
        </div>
      </td>
    </tr>
  );
}
