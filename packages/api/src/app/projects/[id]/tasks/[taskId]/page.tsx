import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { ArrowLeft, ClipboardList, Home } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { TaskDetail } from '@/components/task/task-detail';
import { ExecutionHistory } from '@/components/task/execution-history';
import { TaskActions } from '@/components/task/task-actions';
import { DriftAlertCard } from '@/components/dashboard/drift-alert-card';
import { RealtimeWrapper } from '@/components/realtime-wrapper';

export default async function TaskDetailPage({
  params,
}: {
  params: { id: string; taskId: string };
}) {
  const project = await prisma.project.findUnique({ where: { id: params.id } });
  if (!project) notFound();

  const task = await prisma.task.findUnique({
    where: { id: params.taskId },
    include: {
      executionRuns: { orderBy: { startedAt: 'desc' }, take: 10 },
      driftAlerts: { where: { status: 'open' }, orderBy: { createdAt: 'desc' } },
    },
  });

  if (!task || task.projectId !== params.id) notFound();

  const activePlan = await prisma.plan.findFirst({
    where: { projectId: params.id, status: 'active' },
  });

  const currentUser = cookies().get('plansync-user')?.value ?? 'anonymous';
  const canRebind = !!activePlan && task.boundPlanVersion !== activePlan.version;
  const canClaim = task.status === 'todo' && !task.assignee;
  const canDecline = task.status === 'todo' && task.assignee === currentUser;

  return (
    <RealtimeWrapper projectId={params.id}>
      <div className="page-shell">
        <header className="page-header">
          <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-3">
            <Link href="/" className="btn-ghost !px-2 !py-1.5 shrink-0" title="All Projects">
              <Home className="h-4 w-4" />
            </Link>
            <Link href={`/projects/${params.id}`} className="btn-ghost !px-2 !py-1.5">
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Back to {project.name}</span>
            </Link>
          </div>
        </header>

        <main className="page-container">
          <div className="panel overflow-hidden">
            <div className="panel-header">
              <div className="flex items-center gap-2">
                <ClipboardList className="h-4 w-4 text-blue-500" />
                <span className="text-sm font-semibold text-slate-700">Task Detail</span>
              </div>
              <span className="text-xs text-slate-400 font-mono">{task.id.slice(-8)}</span>
            </div>

            <div className="p-6 space-y-6">
              <TaskDetail task={task} activePlan={activePlan} />

              <TaskActions
                projectId={params.id}
                taskId={params.taskId}
                canRebind={canRebind}
                canClaim={canClaim}
                canDecline={canDecline}
              />

              {task.driftAlerts.length > 0 && (
                <section>
                  <h2 className="section-label mb-3">Drift Alerts</h2>
                  <div className="space-y-2.5">
                    {task.driftAlerts.map((alert) => (
                      <DriftAlertCard
                        key={alert.id}
                        alert={alert}
                        task={task}
                        projectId={params.id}
                      />
                    ))}
                  </div>
                </section>
              )}

              <section>
                <h2 className="section-label mb-3">Execution History</h2>
                <ExecutionHistory runs={task.executionRuns} />
              </section>
            </div>
          </div>
        </main>
      </div>
    </RealtimeWrapper>
  );
}
