import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { GitBranch, Users, CheckCircle2 } from 'lucide-react';

export default async function HomePage() {
  // SSR pages don't have user session context.
  // In production with auth, this should be replaced with API calls
  // or session-based filtering. Safe for AUTH_DISABLED dev mode.
  const projects = await prisma.project.findMany({
    include: {
      _count: { select: { members: true, plans: true, tasks: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitBranch className="h-6 w-6 text-primary" />
            <h1 className="text-xl font-bold">PlanSync</h1>
          </div>
          <p className="text-sm text-muted-foreground">AI Team Plan Coordination</p>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-6">
          <h2 className="text-2xl font-bold">Projects</h2>
          <p className="text-muted-foreground">Select a project to view its dashboard</p>
        </div>

        {projects.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center">
            <p className="text-muted-foreground">No projects yet. Create one via the API.</p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="group rounded-lg border bg-card p-6 transition-colors hover:border-primary/50 hover:shadow-md"
              >
                <h3 className="font-semibold text-lg group-hover:text-primary transition-colors">
                  {project.name}
                </h3>
                {project.description && (
                  <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                    {project.description}
                  </p>
                )}
                <div className="mt-4 flex gap-4 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" />
                    {project._count.members}
                  </span>
                  <span className="flex items-center gap-1">
                    <GitBranch className="h-3.5 w-3.5" />
                    {project._count.plans} plans
                  </span>
                  <span className="flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {project._count.tasks} tasks
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
