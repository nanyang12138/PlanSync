import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, GitBranch, Users } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { MemberInvite } from '@/components/member/member-invite';
import { MemberList } from '@/components/member/member-list';
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
      <div className="page-shell">
        <header className="page-header">
          <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-3">
            <Link href={`/projects/${params.id}`} className="btn-ghost !px-2 !py-1.5">
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Back</span>
            </Link>
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 shadow-sm shrink-0">
                <GitBranch className="h-3.5 w-3.5 text-white" />
              </div>
              <h1 className="truncate text-base font-bold text-slate-900">{project.name}</h1>
              <span className="badge badge-neutral">Members</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <Users className="h-3.5 w-3.5" />
              {members.length} members
            </div>
          </div>
        </header>

        <main className="page-container space-y-6">
          <MemberInvite projectId={params.id} />

          <div className="panel overflow-hidden">
            <div className="panel-header">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-blue-500" />
                <span className="text-sm font-semibold text-slate-700">Team Members</span>
              </div>
            </div>
            <MemberList members={members} projectId={params.id} />
          </div>
        </main>
      </div>
    </RealtimeWrapper>
  );
}
