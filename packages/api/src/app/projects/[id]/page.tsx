import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { PlanCard } from '@/components/dashboard/plan-card';
import { DriftAlertCard } from '@/components/dashboard/drift-alert-card';
import { TeamGrid } from '@/components/dashboard/team-grid';
import { TaskList } from '@/components/dashboard/task-list';
import { ActivityFeed } from '@/components/dashboard/activity-feed';
import { GitBranch, ArrowLeft, Users, FileText } from 'lucide-react';
import { RealtimeWrapper } from '@/components/realtime-wrapper';

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
    take: 20,
  });

  return (
    <RealtimeWrapper projectId={params.id}>
      <div className="min-h-screen bg-background">
        <header className="border-b bg-card">
          <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-4">
            <Link
              href="/"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <div className="flex items-center gap-2">
                <GitBranch className="h-5 w-5 shrink-0 text-primary" />
                <h1 className="text-xl font-bold">{project.name}</h1>
              </div>
              {project.description && (
                <p className="ml-0 text-sm text-muted-foreground md:ml-2">{project.description}</p>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl space-y-6 px-6 py-6">
          {activePlan && <PlanCard plan={activePlan} projectId={params.id} />}

          {driftAlerts.length > 0 && (
            <section>
              <h2 className="mb-3 text-lg font-semibold">Drift Alerts</h2>
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
            </section>
          )}

          <section>
            <h2 className="mb-3 text-lg font-semibold">Team</h2>
            <TeamGrid
              members={project.members}
              tasks={project.tasks}
              activePlanVersion={activePlan?.version}
              driftTaskIds={driftAlerts.map((a) => a.taskId)}
            />
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold">Tasks</h2>
            <TaskList
              tasks={project.tasks}
              activePlanVersion={activePlan?.version}
              projectId={params.id}
            />
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold">Activity</h2>
            <ActivityFeed activities={activities} />
          </section>
          <div className="flex gap-3 pt-2">
            <Link
              href={`/projects/${params.id}/plans`}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
            >
              <FileText className="h-3.5 w-3.5" /> Plan History
            </Link>
            <Link
              href={`/projects/${params.id}/members`}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
            >
              <Users className="h-3.5 w-3.5" /> Manage Members
            </Link>
          </div>
        </main>
      </div>
    </RealtimeWrapper>
  );
}
