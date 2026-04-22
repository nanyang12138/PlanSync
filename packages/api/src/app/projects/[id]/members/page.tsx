import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Users, AlertTriangle, CheckCircle2, Circle, ChevronRight } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { MemberInvite } from '@/components/member/member-invite';
import { MemberList } from '@/components/member/member-list';
import { RealtimeWrapper } from '@/components/realtime-wrapper';
import { PageHeader } from '@/components/shared/page-header';
import { SectionShell } from '@/components/shared/section-shell';

export default async function ProjectMembersPage({ params }: { params: { id: string } }) {
  const project = await prisma.project.findUnique({
    where: { id: params.id },
    include: {
      tasks: true,
      driftAlerts: { where: { status: 'open' } },
      plans: { where: { status: 'active' }, take: 1 },
    },
  });
  if (!project) notFound();

  const members = await prisma.projectMember.findMany({
    where: { projectId: params.id },
    orderBy: { createdAt: 'asc' },
  });

  const activePlanVersion = project.plans[0]?.version;
  const driftTaskIds = new Set(project.driftAlerts.map((a) => a.taskId));

  // Determine member statuses
  const membersWithStatus = members.map((member) => {
    const memberTasks = project.tasks.filter((t) => t.assignee === member.name);

    let status: 'drift' | 'active' | 'idle' = 'idle';
    let currentTask = null;

    if (memberTasks.some((t) => driftTaskIds.has(t.id))) {
      status = 'drift';
      currentTask = memberTasks.find((t) => driftTaskIds.has(t.id));
    } else if (
      activePlanVersion !== undefined &&
      memberTasks.some((t) => t.boundPlanVersion !== activePlanVersion)
    ) {
      status = 'drift';
      currentTask = memberTasks.find((t) => t.boundPlanVersion !== activePlanVersion);
    } else if (memberTasks.some((t) => t.status === 'in_progress' || t.status === 'blocked')) {
      status = 'active';
      currentTask = memberTasks.find((t) => t.status === 'in_progress' || t.status === 'blocked');
    }

    return { ...member, status, currentTask };
  });

  const driftedMembers = membersWithStatus.filter((m) => m.status === 'drift');
  const activeMembers = membersWithStatus.filter((m) => m.status === 'active');
  const idleMembers = membersWithStatus.filter((m) => m.status === 'idle');

  return (
    <RealtimeWrapper projectId={params.id}>
      <div className="page-shell">
        <PageHeader
          breadcrumbs={
            <Link
              href={`/projects/${params.id}`}
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-700 transition-colors font-medium"
              title={`Back to ${project.name}`}
            >
              <ChevronRight className="h-3.5 w-3.5 rotate-180 text-slate-300" />
              {project.name}
            </Link>
          }
          title={<span className="text-sm font-bold text-slate-900">Members</span>}
          navigation={[]}
          actions={
            <div className="flex items-center gap-1.5 text-xs text-slate-500 font-medium">
              <Users className="h-4 w-4" />
              {members.length} members
            </div>
          }
        />

        <main className="page-container space-y-8">
          <MemberInvite projectId={params.id} />

          {/* Blocked / At Risk Members */}
          {driftedMembers.length > 0 && (
            <SectionShell
              title="Blocked by Drift"
              description="These members have tasks that deviate from the active plan."
              icon={<AlertTriangle className="h-5 w-5 text-amber-500" />}
              className="border-amber-200/60 bg-amber-50/10"
            >
              <MemberList members={driftedMembers} projectId={params.id} showStatus={true} />
            </SectionShell>
          )}

          <div className="grid md:grid-cols-2 gap-6">
            {/* Active Members */}
            <SectionShell
              title="Active"
              description="Currently working on aligned tasks."
              icon={<CheckCircle2 className="h-5 w-5 text-emerald-500" />}
            >
              <MemberList members={activeMembers} projectId={params.id} showStatus={true} />
            </SectionShell>

            {/* Idle Members */}
            <SectionShell
              title="Idle"
              description="No active tasks assigned."
              icon={<Circle className="h-5 w-5 text-slate-400" />}
            >
              <MemberList members={idleMembers} projectId={params.id} showStatus={true} />
            </SectionShell>
          </div>
        </main>
      </div>
    </RealtimeWrapper>
  );
}
