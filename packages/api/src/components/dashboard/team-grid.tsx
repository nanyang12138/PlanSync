import type { ProjectMember, Task } from '@prisma/client';
import { Bot, User } from 'lucide-react';

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

  if (members.length === 0) {
    return <p className="text-sm text-slate-500 italic text-center py-4">No team members yet.</p>;
  }

  return (
    <div className="space-y-3">
      {members.map((member) => {
        const status = memberStatus(member, tasks, activePlanVersion, driftTaskIdSet);
        const isAgent = member.type === 'agent';
        const currentTask = tasks.find(
          (t) =>
            t.assignee === member.name && (t.status === 'in_progress' || t.status === 'blocked'),
        );

        return (
          <div key={member.id} className="flex items-center gap-3">
            <div
              className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                status === 'drift'
                  ? 'bg-amber-100 text-amber-600'
                  : status === 'active'
                    ? 'bg-emerald-100 text-emerald-600'
                    : 'bg-slate-100 text-slate-400'
              }`}
            >
              {isAgent ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-slate-900 block truncate">
                {member.name}
              </span>
              <div className="flex items-center gap-1.5 mt-0.5">
                <StatusDot status={status} />
                <span
                  className={`text-xs truncate ${status === 'drift' ? 'text-amber-600 font-medium' : 'text-slate-500'}`}
                >
                  {status === 'drift'
                    ? 'Blocked by drift'
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
  );
}
