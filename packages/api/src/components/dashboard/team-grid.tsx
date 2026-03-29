import type { ProjectMember, Task } from '@prisma/client';
import { Bot, User, Users } from 'lucide-react';

type TeamGridProps = {
  members: ProjectMember[];
  tasks: Task[];
  activePlanVersion?: number;
  driftTaskIds?: readonly string[];
};

type MemberStatus = 'drift' | 'active' | 'idle';

function memberStatus(
  member: ProjectMember,
  tasks: Task[],
  activePlanVersion: number | undefined,
  driftTaskIdSet: Set<string>,
): MemberStatus {
  const mine = tasks.filter((t) => t.assignee === member.name);
  if (mine.some((t) => driftTaskIdSet.has(t.id))) return 'drift';
  if (activePlanVersion !== undefined && mine.some((t) => t.boundPlanVersion !== activePlanVersion))
    return 'drift';
  if (mine.some((t) => t.status === 'in_progress' || t.status === 'blocked')) return 'active';
  return 'idle';
}

function StatusDot({ status }: { status: MemberStatus }) {
  if (status === 'active')
    return (
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
      </span>
    );
  if (status === 'drift') return <span className="inline-flex rounded-full h-2 w-2 bg-amber-500" />;
  return <span className="inline-flex rounded-full h-2 w-2 bg-slate-300" />;
}

export function TeamGrid({ members, tasks, activePlanVersion, driftTaskIds = [] }: TeamGridProps) {
  const driftTaskIdSet = new Set(driftTaskIds);

  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2 mb-3">
        <Users className="h-4 w-4 text-slate-400" />
        <span className="section-label">Team Status</span>
      </div>

      {members.length === 0 ? (
        <p className="text-sm text-slate-400 italic">No team members yet.</p>
      ) : (
        <div className="space-y-3">
          {members.map((member) => {
            const status = memberStatus(member, tasks, activePlanVersion, driftTaskIdSet);
            const isAgent = member.type === 'agent';
            const currentTask = tasks.find(
              (t) =>
                t.assignee === member.name &&
                (t.status === 'in_progress' || t.status === 'blocked'),
            );

            return (
              <div key={member.id} className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                  {isAgent ? (
                    <Bot className="h-3.5 w-3.5 text-violet-400" />
                  ) : (
                    <User className="h-3.5 w-3.5 text-slate-400" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-slate-700 block truncate">
                    {member.name}
                  </span>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <StatusDot status={status} />
                    <span
                      className={`text-xs ${status === 'drift' ? 'text-amber-600 font-medium' : 'text-slate-500'}`}
                    >
                      {status === 'drift'
                        ? 'Drift — paused'
                        : status === 'active' && currentTask
                          ? currentTask.title
                          : status === 'active'
                            ? 'Working'
                            : 'Idle'}
                    </span>
                  </div>
                </div>
                <span className={`badge text-[10px] ${isAgent ? 'badge-violet' : 'badge-neutral'}`}>
                  {isAgent ? 'Agent' : member.role}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
