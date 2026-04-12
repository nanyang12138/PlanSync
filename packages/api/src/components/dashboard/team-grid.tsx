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

const statusLabel: Record<MemberStatus, string> = {
  active: 'Active',
  drift: 'Drift',
  idle: 'Idle',
};

const statusTextCls: Record<MemberStatus, string> = {
  active: 'text-emerald-600',
  drift: 'text-amber-600 font-medium',
  idle: 'text-slate-400',
};

export function TeamGrid({ members, tasks, activePlanVersion, driftTaskIds = [] }: TeamGridProps) {
  const driftTaskIdSet = new Set(driftTaskIds);

  if (members.length === 0) {
    return <p className="text-sm text-slate-500 italic text-center py-4">No team members yet.</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2">
      {members.map((member) => {
        const status = memberStatus(member, tasks, activePlanVersion, driftTaskIdSet);
        const isAgent = member.type === 'agent';

        return (
          <div key={member.id} className="flex items-center gap-2 min-w-0">
            <div
              className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
                status === 'drift'
                  ? 'bg-amber-100 text-amber-600'
                  : status === 'active'
                    ? 'bg-emerald-100 text-emerald-600'
                    : 'bg-slate-100 text-slate-400'
              }`}
            >
              {isAgent ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
            </div>
            <div className="min-w-0">
              <span className="text-xs font-medium text-slate-800 block truncate leading-tight">
                {member.name}
              </span>
              <div className="flex items-center gap-1 mt-0.5">
                <StatusDot status={status} />
                <span className={`text-[10px] ${statusTextCls[status]}`}>
                  {statusLabel[status]}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
