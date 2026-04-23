import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { ArrowLeft, ClipboardList, Home } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { TaskDetail } from '@/components/task/task-detail';
import { TaskEditor } from '@/components/task/task-editor';
import { TaskDatesEditor } from '@/components/task/task-dates-editor';
import { TaskCompleteHuman } from '@/components/task/task-complete-human';
import { ExecutionHistory } from '@/components/task/execution-history';
import { TaskActions } from '@/components/task/task-actions';
import { DriftAlertCard } from '@/components/dashboard/drift-alert-card';
import { RealtimeWrapper } from '@/components/realtime-wrapper';
import { LiveExecutionBanner } from '@/components/task/live-execution-banner';
import { ExecutionSummary } from '@/components/task/execution-summary';

export default async function TaskDetailPage({
  params,
}: {
  params: { id: string; taskId: string };
}) {
  const project = await prisma.project.findUnique({
    where: { id: params.id },
    include: { members: { select: { name: true } } },
  });
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

  const canRebind = !!activePlan && task.boundPlanVersion !== activePlan.version;
  const canClaim = task.status === 'todo' && !task.assignee;
  const canDecline = task.status === 'todo' && !!task.assignee && task.assigneeType !== 'agent';

  // Derive execution state for new components
  const runningRun = task.executionRuns.find((r) => r.status === 'running') ?? null;
  const latestCompletedRun = task.executionRuns.find((r) => r.status === 'completed') ?? null;

  const canCompleteHuman =
    (task.status === 'in_progress' || task.status === 'todo') &&
    !!task.assignee &&
    task.assigneeType !== 'agent' &&
    !runningRun;

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
              <TaskEditor
                task={task}
                projectId={params.id}
                memberNames={project.members.map((m) => m.name)}
              />
            </div>

            <div className="p-6 space-y-6">
              <TaskDetail task={task} activePlan={activePlan} />

              {/* Live execution indicator */}
              <LiveExecutionBanner
                run={
                  runningRun
                    ? {
                        executorName: runningRun.executorName,
                        executorType: runningRun.executorType,
                        startedAt: runningRun.startedAt.toISOString(),
                      }
                    : null
                }
              />

              <TaskDatesEditor
                projectId={params.id}
                taskId={params.taskId}
                startDate={task.startDate}
                dueDate={task.dueDate}
              />

              <TaskActions
                projectId={params.id}
                taskId={params.taskId}
                canRebind={canRebind}
                canClaim={canClaim}
                canDecline={canDecline}
              />

              {canCompleteHuman && (
                <TaskCompleteHuman projectId={params.id} taskId={params.taskId} />
              )}

              {/* Latest execution summary */}
              <ExecutionSummary run={latestCompletedRun} />

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
                <ExecutionHistory
                  runs={task.executionRuns}
                  latestCompletedRunId={latestCompletedRun?.id}
                />
              </section>
            </div>
          </div>
        </main>
      </div>
    </RealtimeWrapper>
  );
}
