import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ClipboardList } from 'lucide-react';
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

  const canRebind = !!activePlan && task.boundPlanVersion !== activePlan.version;
  const canClaim = task.status === 'todo';

  return (
    <RealtimeWrapper projectId={params.id}>
      <div className="min-h-screen bg-background">
        <header className="border-b bg-card">
          <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-4">
            <Link
              href={`/projects/${params.id}`}
              className="inline-flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-5 w-5" />
              <span className="text-sm font-medium">Back to {project.name}</span>
            </Link>
          </div>
        </header>

        <main className="mx-auto max-w-7xl space-y-6 px-6 py-6">
          <div className="flex flex-wrap items-center gap-2">
            <ClipboardList className="h-6 w-6 text-primary" />
            <h2 className="text-lg font-semibold text-muted-foreground">Task</h2>
          </div>

          <TaskDetail task={task} activePlan={activePlan} />

          <TaskActions
            projectId={params.id}
            taskId={params.taskId}
            canRebind={canRebind}
            canClaim={canClaim}
          />

          {task.driftAlerts.length > 0 && (
            <section>
              <h2 className="mb-3 text-lg font-semibold">Drift alerts</h2>
              <div className="space-y-3">
                {task.driftAlerts.map((alert) => (
                  <DriftAlertCard key={alert.id} alert={alert} task={task} projectId={params.id} />
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="mb-3 text-lg font-semibold">Execution history</h2>
            <ExecutionHistory runs={task.executionRuns} />
          </section>
        </main>
      </div>
    </RealtimeWrapper>
  );
}
