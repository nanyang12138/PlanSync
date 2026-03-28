import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, GitBranch } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { MemberInvite } from '@/components/member/member-invite';
import { MemberList, MemberListHeader } from '@/components/member/member-list';
import { RealtimeWrapper } from '@/components/realtime-wrapper';

export default async function ProjectMembersPage({ params }: { params: { id: string } }) {
  const project = await prisma.project.findUnique({ where: { id: params.id } });
  if (!project) notFound();

  const members = await prisma.projectMember.findMany({
    where: { projectId: params.id },
    orderBy: { createdAt: 'asc' },
  });

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
              <span className="text-sm font-medium">Back to dashboard</span>
            </Link>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <GitBranch className="h-5 w-5 shrink-0 text-primary" />
              <h1 className="truncate text-xl font-bold">{project.name}</h1>
              <span className="text-sm text-muted-foreground">· Members</span>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-7xl space-y-8 px-6 py-6">
          <MemberInvite projectId={params.id} />
          <section>
            <MemberListHeader />
            <MemberList members={members} projectId={params.id} />
          </section>
        </main>
      </div>
    </RealtimeWrapper>
  );
}
