import type { ProjectMember, Task } from '@prisma/client';
import { Bot, User } from 'lucide-react';
import { cn } from '@/lib/utils';

type TeamGridProps = {
  members: ProjectMember[];
  tasks: Task[];
  /** When set, tasks bound to a different version are treated as version drift for that member. */
  activePlanVersion?: number;
  /** Task IDs with an open drift alert (takes precedence for status). */
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
  const driftTasks = mine.filter((t) => driftTaskIdSet.has(t.id));
  if (driftTasks.length > 0) return 'drift';

  if (activePlanVersion !== undefined) {
    const versionDrift = mine.filter((t) => t.boundPlanVersion !== activePlanVersion);
    if (versionDrift.length > 0) return 'drift';
  }

  const busy = mine.filter((t) => t.status === 'in_progress' || t.status === 'blocked');
  if (busy.length > 0) return 'active';

  return 'idle';
}

function statusLabel(status: MemberStatus) {
  switch (status) {
    case 'drift':
      return { label: 'Drift', className: 'bg-amber-500/15 text-amber-900 dark:text-amber-200' };
    case 'active':
      return { label: 'Active', className: 'bg-primary/15 text-primary' };
    default:
      return { label: 'Idle', className: 'bg-muted text-muted-foreground' };
  }
}

export function TeamGrid({ members, tasks, activePlanVersion, driftTaskIds = [] }: TeamGridProps) {
  const driftTaskIdSet = new Set(driftTaskIds);

  if (members.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
        No team members yet.
      </p>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {members.map((member) => {
        const status = memberStatus(member, tasks, activePlanVersion, driftTaskIdSet);
        const badge = statusLabel(status);
        const isAgent = member.type === 'agent';

        return (
          <div
            key={member.id}
            className={cn(
              'flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                    'bg-muted text-muted-foreground',
                  )}
                  aria-hidden
                >
                  {isAgent ? <Bot className="h-5 w-5" /> : <User className="h-5 w-5" />}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium">{member.name}</p>
                  <p className="text-xs capitalize text-muted-foreground">
                    {member.role} · {isAgent ? 'Agent' : 'Human'}
                  </p>
                </div>
              </div>
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold',
                  badge.className,
                )}
              >
                {badge.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
